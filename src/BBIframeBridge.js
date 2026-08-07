/*
 * Copyright Blue Billywig 2023+
 * ISC License
 * author(s): J. Koppen (j.koppen --at-- bluebillywig.com)
 * language: ES6 (2015)
 */

/*
 * Commands the child iframe may invoke on the parent bridge via postMessage.
 *
 * Replaces dynamic `this[ev.data.methodName]` dispatch. The old test was
 * `typeof this[methodName] === 'function'`, which walks the prototype chain, so it exposed not just
 * every public method on the class but `constructor`, `toString`, `valueOf` and `hasOwnProperty`
 * too. Deliberately absent:
 *  - setLocation: assigns window.location.href, i.e. a redirect / `javascript:` primitive
 *  - exit: lets a child tear down its own bridge
 *  - callParent / callChild: turn the bridge into a message relay
 * Direct calls on the instance (br.setLocation(...)) are unaffected -- only the message path is
 * restricted. Fullscreen is driven by the legacy string protocol below, not by name dispatch.
 */
const CHILD_COMMANDS = new Set([
	'setIframeSize',
	'setLocalStorageItem',
	'getLocalStorageItem',
	'getLocalStorageItems',
	'getLocation',
	'getReferrer',
	'onBlueBillywigInstanceReady'
]);

class BBIframeBridge {
	/**
	 * constructor
	 * @param {Object} iframe optional, default null
	 */
	constructor (iframe = null) {
		this._iframe = iframe;
		// URL, not a regex. The previous /^(https?:|)(\/\/[a-z0-9.-]+)\// yielded '//host' for a
		// protocol-relative src -- not a legal targetOrigin, so postMessage throws SyntaxError on it
		// -- and failed to match a host with a port at all, silently disabling origin validation for
		// every non-default-port embed. URL also resolves a relative src against the document, so
		// those now validate normally instead of falling back to '*'; only an opaque or unparseable
		// src leaves us with nothing to compare.
		this._iframeOrigin = '*';
		if (this._iframe && this._iframe.src) {
			try {
				const origin = new URL(this._iframe.src, window.location.href).origin;
				// Opaque origins (data:, about:blank, sandboxed frames) stringify to 'null', which is
				// also not a legal targetOrigin.
				if (origin && origin !== 'null') this._iframeOrigin = origin;
			} catch (er) { /* leave '*' and warn below */ }
		}
		// Only complain when there WAS an src we failed to parse. A bridge is constructed for every
		// iframe on the page (see bootstrap), including src-less ad slots and srcdoc frames, and
		// warning about those would be noise about a normal state.
		if (this._iframeOrigin === '*' && this._iframe && this._iframe.src) {
			console.warn('[BBIframeBridge] could not derive an origin from iframe.src "' + this._iframe.src + '"; inbound origin validation is disabled for this bridge');
		}

		// Warn-only by default (#19020): origin mismatches are logged but still handled, so live
		// integrations keep working while we collect telemetry. Flip once the warn traffic is known.
		this._enforceOrigin = false;

		// Learned from ev.origin on the first message the parent sends us -- the browser sets that
		// field, so it is the only trustworthy statement of the parent's origin available here.
		// document.referrer is NOT a substitute: on a top-level page it is whatever site linked the
		// user here, so using it would target a third-party origin and the message would be dropped.
		this._parentOrigin = null;

		this._queueChild = [];
		this._queueParent = [];
		this._inMemoryStorage = {};
		this._isectObserver = null;
		this._metaViewportLocked = false;
		this._metaViewportContent = '';
		this._oldStyle = null;
		this._handshakeSucceededChild = false;
		this._handshakeSucceededParent = false;

		this._onKeyDownBound = this._onKeyDown.bind(this);
		this._onMessageBound = this._onMessage.bind(this);
		this._onDeviceOrientationBound = this._onDeviceOrientation.bind(this);
		this._onOrientationChangeBound = this._onOrientationChange.bind(this);
		this._onFullscreenChangeBound = this._onFullscreenChange.bind(this);

		window.addEventListener('message', this._onMessageBound);
		window.addEventListener('deviceorientation', this._onDeviceOrientationBound, { passive: true });
		window.addEventListener('orientationchange', this._onOrientationChangeBound, { passive: true });

		document.addEventListener('fullscreenchange', this._onFullscreenChangeBound);
		document.addEventListener('fullscreenchanged', this._onFullscreenChangeBound);
		document.addEventListener('webkitfullscreenchange', this._onFullscreenChangeBound);
		document.addEventListener('MSFullscreenChange', this._onFullscreenChangeBound);
		document.addEventListener('mozfullscreenchange', this._onFullscreenChangeBound);

		try {
			// _iframeOrigin is a real origin or '*' -- never a partial like '//host', which is not a
			// legal targetOrigin and would throw SyntaxError into the catch below, silently killing
			// the handshake.
			this._iframe?.contentWindow?.postMessage('handshake', this._iframeOrigin);
		} catch (er) {
			console.warn('[BBIframeBridge] constructor failed to postMessage; ' + er);
		}

		this._setupIsectObserver();
	}

	/**
	 * destructor
	 */
	exit () {
		window.removeEventListener('message', this._onMessageBound);
		window.removeEventListener('deviceorientation', this._onDeviceOrientationBound, { passive: true });
		window.removeEventListener('orientationchange', this._onOrientationChangeBound, { passive: true });

		document.removeEventListener('fullscreenchange', this._onFullscreenChangeBound);
		document.removeEventListener('fullscreenchanged', this._onFullscreenChangeBound);
		document.removeEventListener('webkitfullscreenchange', this._onFullscreenChangeBound);
		document.removeEventListener('MSFullscreenChange', this._onFullscreenChangeBound);
		document.removeEventListener('mozfullscreenchange', this._onFullscreenChangeBound);

		return null;
	}

	/**
	 *
	 * @param {String} instanceId
	 * @param {String} className
	 */
	onBlueBillywigInstanceReady (instanceId, className, iframeSrc = null) {
		this._instanceId = instanceId;
		this._className = className;
	}

	/**
	 * call void method on parent frame
	 * @param {String} methodName
	 * @param {Object} params optional, default {}
	 */
	callParent (methodName, params = {}) {
		if (this._handshakeSucceededParent) {
			try {
				const paramsJson = (typeof params === 'string' && params.match(/^[{[]/)) ? params : JSON.stringify(params);
				window.parent.postMessage({ methodName, paramsJson }, this._parentTargetOrigin());
			} catch (er) {
				console.warn('[BBIframeBridge] callParent failed to postMessage; ' + er);
			}
		} else {
			this._queueParent.push({ methodName, params });
		}
	}

	/**
	 * call void method on child frame
	 * @param {String} methodName
	 * @param {Object} params optional, default []
	 */
	callChild (methodName, params = []) {
		if (this._handshakeSucceededChild) {
			try {
				const paramsJson = (typeof params === 'string' && params.match(/^[{[]/)) ? params : JSON.stringify(params);
				this._iframe?.contentWindow?.postMessage({ methodName, paramsJson }, this._iframeOrigin);
			} catch (er) {
				console.warn('[BBIframeBridge] callChild failed to postMessage; ' + er);
			}
		} else {
			this._queueChild.push({ methodName, params });
		}
	}

	// private
	async callChildPromise (methodName, params = []) {
		let onMessage = null;
		const childPromise = new Promise((resolve) => {
			onMessage = (ev) => {
				// Without this check any window on the page could post a 'return' and decide what
				// this promise resolves to.
				if (!this._isTrustedChildMessage(ev)) return;
				if (ev?.data?.methodName === 'return' && ev.data.returnKey === methodName) {
					resolve(ev.data.returnValue);
				}
			};
			window.addEventListener('message', onMessage);
		});
		const localPromise = new Promise((resolve) => {
			window.setTimeout(() => {
				resolve(null); // default
			}, 240);
		});
		this.callChild(methodName, params);
		// Unbind on BOTH outcomes: the listener used to leak whenever the child never replied, and
		// every leaked listener re-runs _isTrustedChildMessage on every later message.
		return Promise.race([childPromise, localPromise]).finally(() => {
			window.removeEventListener('message', onMessage);
		});
	}

	/**
	 * set localStorage item
	 * @param {String} key
	 * @param {any?} value
	 */
	setLocalStorageItem (key, value) {
		if (value != null) {
			const keyValue = (key?.match(/^bbtl_/)) ? value : JSON.stringify(value); // NB!
			try {
				window.localStorage.setItem(key, keyValue);
			} catch (er) {
				this._inMemoryStorage[key] = keyValue;
			}
		} else { // null => remove
			try {
				window.localStorage.removeItem(key)
			} catch (er) {
				delete this._inMemoryStorage[key];
			}
		}
	}

	/**
	 * get localStorage item
	 * @param {String} key
	 * @return {any?} value or NULL
	 */
	getLocalStorageItem (key) {
		let keyValue = null;
		try {
			keyValue = window.localStorage.getItem(key);
		} catch (er) {
			keyValue = this._inMemoryStorage[key] || null;
		}
		const value = (key.match(/^bbtl_/) || keyValue == null) ? keyValue : JSON.parse(keyValue); // NB!
		return value;
	}

	/**
	 * get all localStorage items
	 */
	getLocalStorageItems () {
		const items = [];

		try {
			const length = window.localStorage.length;
			for (let i = 0; i < length; i++) {
				const key = window.localStorage.key(i);
				const keyValue = window.localStorage.getItem(key);
				const value = (key.match(/^bbtl_/)) ? keyValue : JSON.parse(keyValue); // NB!
				items.push({ key, value });
			}
		} catch (er) {
			for (let key in this._inMemoryStorage) {
				if (Object.hasOwn(this._inMemoryStorage, key)) {
					const keyValue = this._inMemoryStorage[key];
					const value = (key.match(/^bbtl_/)) ? keyValue : JSON.parse(keyValue); // NB!
					items.push({ key, value });
				}
			}
		}

		return items;
	}

	setLocation (value) {
		window.location.href = value;
	}

	getLocation () {
		return window.location.href;
	}

	getReferrer () {
		return document.referrer;
	}

	/**
	 * update iframe size based on dimensions provided by child
	 * @param {Object} dimensions object containing optional width and/or height properties
	 * @param {Number|String} dimensions.width optional width value
	 * @param {Number|String} dimensions.height optional height value
	 * @return {Boolean} success
	 */
	setIframeSize (dimensions) {
		if (!this._iframe) {
			return false;
		}

		if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
			console.warn('[BBIframeBridge] setIframeSize requires an object with width and/or height properties');
			return false;
		}

		const normalizedWidth = this._normalizeDimension(dimensions.width);
		const normalizedHeight = this._normalizeDimension(dimensions.height);

		if (normalizedWidth !== null) {
			this._iframe.style.width = normalizedWidth;
		}

		if (normalizedHeight !== null) {
			this._iframe.style.height = normalizedHeight;
		}

		return true;
	}

	/**
	 * Normalize and validate dimension values to prevent CSS injection
	 * @access private
	 * @param {Number|String} value dimension value to normalize
	 * @return {String|null} normalized CSS dimension or null if invalid
	 */
	_normalizeDimension (value) {
		if (value == null || value === '') {
			return null;
		}

		// Handle numeric values - convert to pixels
		if (typeof value === 'number') {
			if (!isFinite(value) || value < 0) {
				console.warn('[BBIframeBridge] Invalid dimension: negative or non-finite numbers not allowed');
				return null;
			}
			return `${value}px`;
		}

		// Handle string values with validation
		if (typeof value === 'string') {
			const trimmed = value.trim();

			// Allowed CSS units - whitelist approach
			const validPattern = /^(\d+(?:\.\d+)?)(px|%|em|rem|vh|vw|vmin|vmax)$/i;
			const match = trimmed.match(validPattern);

			if (!match) {
				console.warn('[BBIframeBridge] Invalid dimension format: must be a number followed by a valid CSS unit (px, %, em, rem, vh, vw, vmin, vmax)');
				return null;
			}

			const numericValue = parseFloat(match[1]);
			const unit = match[2].toLowerCase();

			// Additional validation: no negative values
			if (numericValue < 0) {
				console.warn('[BBIframeBridge] Invalid dimension: negative values not allowed');
				return null;
			}

			return `${numericValue}${unit}`;
		}

		console.warn('[BBIframeBridge] Invalid dimension type: must be a number or string');
		return null;
	}

	/**
	 * enter fullbrowser
	 * @param {Object} element optional, default window
	 * @return {Boolean} success
	 */
	enterFullBrowser (el) {
		el = el || window;

		document.addEventListener('keydown', this._onKeyDownBound);

		// Lock zoom
		let metaViewport = document.querySelector('head meta[name="viewport"]');
		if (!metaViewport) {
			metaViewport = document.createElement('meta');
			metaViewport.name = 'viewport';
			metaViewport = document.querySelector('head').appendChild(metaViewport);
		}
		if (metaViewport && !this._metaViewportLocked) {
			this._metaViewportLocked = true;
			this._metaViewportContent = metaViewport.content || '';
			metaViewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=1';
		}

		// window.parent && window.parent.postMessage('fullbrowser', '*'); // NB since we ourselves might be iframed too!

		// Save old element style
		if (!this._oldStyle) {
			this._oldStyle = {};
			this._oldStyle.position = el.style.position;
			this._oldStyle.top = el.style.top;
			this._oldStyle.left = el.style.left;
			this._oldStyle.bottom = el.style.bottom;
			this._oldStyle.right = el.style.right;
			this._oldStyle.zIndex = el.style.zIndex;
			this._oldStyle.width = el.style.width;
			this._oldStyle.height = el.style.height;
		}
		// Override element style
		el.style.position = 'fixed';
		el.style.top = '0';
		el.style.left = '0';
		el.style.bottom = '0';
		el.style.right = '0';
		el.style.zIndex = '999999';
		el.style.width = '100vw';
		el.style.height = '100vh';

		return true;
	}

	/**
	 * cancel fullbrowser
	 * @param {Object} el optional, default window
	 * @return {Boolean} success
	 */
	cancelFullBrowser (el) {
		el = el || window;

		// Restore old element style
		if (this._oldStyle) {
			el.style.position = this._oldStyle.position;
			el.style.width = this._oldStyle.width;
			el.style.height = this._oldStyle.height;
			el.style.top = this._oldStyle.top;
			el.style.left = this._oldStyle.left;
			el.style.bottom = this._oldStyle.bottom;
			el.style.right = this._oldStyle.right;
			el.style.zIndex = this._oldStyle.zIndex;
			this._oldStyle = null;
		}

		// window.parent && window.parent.postMessage('fullbrowser-off', '*'); // NB since we ourselves might be iframed too!

		// Unlock zoom
		let metaViewport = document.querySelector('head meta[name="viewport"]');
		if (metaViewport && this._metaViewportLocked) {
			this._metaViewportLocked = false;
			metaViewport.content = this._metaViewportContent;
		}

		document.removeEventListener('keydown', this._onKeyDownBound);

		return true;
	}

	/**
	 * enter fullscreen
	 * @param {Object} element optional, default window
	 * @return {Boolean} success
	 */
	enterFullScreen (el) {
		el = el || window;
		let ret = false;

		this.enterFullBrowser(el);

		// window.parent && window.parent.postMessage('fullscr', '*'); // NB since we ourselves might be iframed too!

		if (el) {
			let requestFullscreen = null;
			if (typeof el.requestFullscreen === 'function') { // lower-case 's' (acc. W3C)
				requestFullscreen = 'requestFullscreen';
			} else if (typeof el.requestFullScreen === 'function') { // upper-case 's'
				requestFullscreen = 'requestFullScreen';
			} else if (typeof el.enterFullscreen === 'function') { // lower-case 's'
				requestFullscreen = 'enterFullscreen';
			} else if (typeof el.enterFullScreen === 'function') { // upper-case 's'
				requestFullscreen = 'enterFullScreen';
			} else {
				const vendorPrefixes = ['o', 'ms', 'moz', 'webkit', 'khtml'];
				for (let i = 0; i < vendorPrefixes.length && !requestFullscreen; i++) {
					const pf = vendorPrefixes[i];
					if (typeof el[pf + 'RequestFullscreen'] === 'function') { // lower-case 's'
						requestFullscreen = pf + 'RequestFullscreen';
					} else if (typeof el[pf + 'RequestFullScreen'] === 'function') { // upper-case 's'
						requestFullscreen = pf + 'RequestFullScreen';
					} else if (typeof el[pf + 'EnterFullscreen'] === 'function') { // lower-case 's'
						requestFullscreen = pf + 'EnterFullscreen';
					} else if (typeof el[pf + 'EnterFullScreen'] === 'function') { // upper-case 's'
						requestFullscreen = pf + 'EnterFullScreen';
					}
				}
			}
			if (requestFullscreen) {
				try {
					const fsp = el[requestFullscreen]();
					if (fsp && typeof fsp.then === 'function') { // promise
						fsp.then(() => {
							this._fullScreen = true;
						}).catch((reason) => {});
					} else {
						this._fullScreen = true;
					}
					ret = true;
				} catch (er) {}
			}
		}

		// Notify child of fullscreen state (for fullbrowser mode where no native event fires)
		this._fullScreen = true;
		this.callChild('handleParentDocumentEvent', { eventType: 'fullscreenchange', eventProps: { isRealFullscreen: ret, isFullscreen: true } });

		return ret;
	}

	/**
	 * cancel fullscreen
	 * @param {Object} element optional, default window
	 * @return {Boolean} success
	 */
	cancelFullScreen (el) {
		el = el || window;
		let ret = false;

		if (document) { // this._isRealFullscreen) {
			let exitFullscreen = null;
			if (typeof document.exitFullscreen === 'function') { // lower-case 's' (acc. W3C)
				exitFullscreen = 'exitFullscreen';
			} else if (typeof document.exitFullScreen === 'function') { // upper-case 's'
				exitFullscreen = 'exitFullScreen';
			} else if (typeof document.cancelFullscreen === 'function') { // lower-case 's'
				exitFullscreen = 'cancelFullscreen';
			} else if (typeof document.cancelFullScreen === 'function') { // upper-case 's'
				exitFullscreen = 'cancelFullScreen';
			} else {
				const vendorPrefixes = ['o', 'ms', 'moz', 'webkit', 'khtml'];
				for (let i = 0; i < vendorPrefixes.length; i++) {
					const pf = vendorPrefixes[i];
					if (typeof document[pf + 'ExitFullscreen'] === 'function') { // lower-case 's'
						exitFullscreen = pf + 'ExitFullscreen';
					} else if (typeof document[pf + 'ExitFullScreen'] === 'function') { // upper-case 's'
						exitFullscreen = pf + 'ExitFullScreen';
					} else if (typeof document[pf + 'CancelFullscreen'] === 'function') { // lower-case 's'
						exitFullscreen = pf + 'CancelFullscreen';
					} else if (typeof document[pf + 'CancelFullScreen'] === 'function') { // upper-case 's'
						exitFullscreen = pf + 'CancelFullScreen';
					}
				}
			}
			if (exitFullscreen) {
				try {
					const fsp = document[exitFullscreen]();
					if (fsp && typeof fsp.then === 'function') { // promise
						fsp.then(() => {
							this._fullScreen = false;
						}).catch((reason) => {});
					} else {
						this._fullScreen = false;
					}
					ret = true;
				} catch (er) {}
			}
		}

		// window.parent && window.parent.postMessage('cancelfullscr', '*'); // NB since we ourselves might be iframed too!

		this.cancelFullBrowser(el);

		// Notify child of fullscreen state
		this._fullScreen = false;
		this.callChild('handleParentDocumentEvent', { eventType: 'fullscreenchange', eventProps: { isRealFullscreen: false, isFullscreen: false } });

		return ret;
	}

	_setupIsectObserver () {
		this._isectObserver?.disconnect();
		if (this._iframe && typeof window.IntersectionObserver === 'function') {
			this._isectObserver = new IntersectionObserver((entries) => {
				let isIntersecting = null;
				entries.forEach((entry) => {
					if (entry.target === this._iframe) {
						isIntersecting = entry.isIntersecting;
					}
				});
				this.callChild('setInView', [isIntersecting]);
			}, {
				threshold: 0.5
			});
			this._isectObserver.observe(this._iframe);
		}
	}

	/**
	 * @access private
	 */
	_onKeyDown (ev) {
		switch (ev && ev.keyCode) {
		case 27: // esc
			this.cancelFullScreen(this._iframe);
			break;
		}
	}

	/**
	 * targetOrigin for outgoing messages to the parent frame.
	 *
	 * Falls back to '*' until the parent has identified itself via a message, because narrowing to a
	 * guess would silently drop messages the bridge has always delivered.
	 *
	 * @access private
	 * @return {String}
	 */
	_parentTargetOrigin () {
		return this._parentOrigin || '*';
	}

	/**
	 * Whether a message should be treated as coming from the child iframe this bridge owns.
	 *
	 * ev.source is set by the browser and cannot be forged, but it survives a navigation: an iframe
	 * moved to a hostile origin after load keeps the same contentWindow. So the origin is
	 * re-validated on every message rather than trusted once from iframe.src at construction.
	 *
	 * NOT a pure "is this trustworthy" predicate in the shipped configuration. With the default
	 * `_enforceOrigin = false` it returns true for a message it has just judged to be from the wrong
	 * origin (warn-only rollout), and it also returns true when no origin could be derived from
	 * iframe.src at all. A false return always means untrusted; a true return means "dispatch it",
	 * which under warn-only is a weaker statement.
	 *
	 * @access private
	 * @param {MessageEvent} ev
	 * @return {Boolean} whether the caller should act on the message
	 */
	_isTrustedChildMessage (ev) {
		if (!this._iframe || ev.source !== this._iframe.contentWindow) return false;
		// No origin was derivable from iframe.src, so there is nothing to compare against. Warned
		// about at construction only when there WAS an src -- a src-less iframe reaches here
		// silently, by design.
		if (this._iframeOrigin === '*') return true;
		// Hand-constructed events (tests, jsdom) carry an empty origin. Real browsers always set it:
		// a serialized origin, or the literal string 'null' for an opaque one -- which is handled by
		// the mismatch branch below rather than trusted, since it cannot be verified.
		if (typeof ev.origin !== 'string' || ev.origin === '') return true;
		if (ev.origin === this._iframeOrigin) return true;

		console.warn('[BBIframeBridge] message origin "' + ev.origin + '" does not match iframe origin "' + this._iframeOrigin + '"' + (this._enforceOrigin ? '; dropped' : '; allowing in warn-only mode'));
		return !this._enforceOrigin;
	}

	/**
	 * @access private
	 */
	_onMessage (ev) {
		if (ev) {
			// Source-only, no origin check. The handshake carries no authority -- it just opens the
			// channel -- and dropping it on an origin mismatch would leave _handshakeSucceededChild
			// false forever: every callChild queues indefinitely and fullscreen stops working, with
			// nothing in the log saying the bridge is dead. The localStorage push that follows the
			// handshake is protected by its targetOrigin (this._iframeOrigin), so a child that
			// navigated away cannot receive it regardless.
			const isChildSource = !!(this._iframe && ev.source === this._iframe.contentWindow);
			const isChildIframe = this._isTrustedChildMessage(ev);
			// Learn the parent's origin from the browser-set field the first time it talks to us, so
			// outgoing callParent messages can be targeted instead of broadcast with '*'.
			if (!isChildIframe && ev.source === window.parent && this._parentOrigin === null &&
				typeof ev.origin === 'string' && ev.origin !== '' && ev.origin !== 'null') {
				this._parentOrigin = ev.origin;
			}
			if (typeof ev.data === 'string') { // legacy
				switch (ev.data) {
				case 'handshake': // "SYN"
					if (isChildSource) { // child
						try {
							this._iframe.contentWindow.postMessage('handshakeSucceeded', this._iframeOrigin);
						} catch (er) {
							console.warn('[BBIframeBridge] _onMessage failed to postMessage handshakeSucceeded; ' + er);
						}
					} else if (ev.source === window.parent) { // parent
						try {
							window.parent.postMessage('handshakeSucceeded', this._parentTargetOrigin());
						} catch (er) {
							console.warn('[BBIframeBridge] _onMessage failed to postMessage handshakeSucceeded; ' + er);
						}
					}
					// eslint-disable-next-line no-fallthrough
				case 'handshakeSucceeded': // "ACK"
					if (isChildSource) { // child
						// push localStorage
						try {
							const items = this.getLocalStorageItems();
							this._iframe.contentWindow.postMessage({ methodName: 'setLocalStorageItems', paramsJson: JSON.stringify([items]) }, this._iframeOrigin);
						} catch (er) {
							console.warn('[BBIframeBridge] _onMessage failed to postMessage setLocalStorageItems; ' + er);
						}

						// handle queued calls
						this._handshakeSucceededChild = true;
						while (this._queueChild.length > 0) {
							const qitem = this._queueChild.shift();
							this.callChild(qitem.methodName, qitem.params);
						}
					} else if (ev.source === window.parent) { // parent
						// handle queued calls
						this._handshakeSucceededParent = true;
						while (this._queueParent.length > 0) {
							const qitem = this._queueParent.shift();
							this.callParent(qitem.methodName, qitem.params);
						}
					} // else: message from another iframe on the page - ignore silently
					break;
				case 'fullbrowser':
					if (isChildIframe) {
						this.enterFullScreen(this._iframe);
					}
					break;
				case 'fullbrowser-off':
					if (isChildIframe) {
						this.cancelFullScreen(this._iframe);
					}
					break;
				case 'fullscr':
					if (isChildIframe) {
						this.enterFullScreen(this._iframe);
					}
					break;
				case 'cancelfullscr':
					if (isChildIframe) {
						this.cancelFullScreen(this._iframe);
					}
					break;
				}
			} else if (
				typeof ev.data === 'object' && // modern
				ev.data !== null &&
				typeof ev.data.methodName === 'string' && // valid
				isChildIframe
			) {
				const methodName = ev.data.methodName;
				if (!CHILD_COMMANDS.has(methodName)) {
					// 'return' is the reply channel, handled by callChildPromise -- not a command.
					if (methodName !== 'return') {
						console.warn('[BBIframeBridge] command "' + methodName + '" is not callable from the child iframe; dropped');
					}
					return;
				}

				let params = ev.data.params;
				try {
					params = JSON.parse(ev.data.paramsJson);
				} catch (er) {}
				let returnValue;
				if (Array.isArray(params)) {
					returnValue = this[methodName].apply(this, params);
				} else {
					returnValue = this[methodName](params);
				}
				if (typeof returnValue !== 'undefined') {
					try {
						this._iframe?.contentWindow?.postMessage({methodName: 'return', returnKey: methodName, returnValue}, this._iframeOrigin);
					} catch (_) {}
				}
			}
		}
	}

	/**
	 * @access private
	 */
	_onDeviceOrientation (ev) {
		ev && this.callChild('handleParentWindowEvent', { eventType: 'deviceorientation', eventProps: { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma } });
	}

	/**
	 * @access private
	 */
	_onOrientationChange (ev) {
		let orientation = window.orientation || 0;
		switch ((window.screen.orientation && window.screen.orientation.type) || window.screen.mozOrientation) {
		case 'landscape-primary':
			orientation = 90;
			break;
		case 'landscape-secondary':
			orientation = -90;
			break;
		case 'portrait-secondary':
			orientation = 180;
			break;
		case 'portrait-primary':
			orientation = 0;
			break;
		}
		ev && this.callChild('handleParentWindowEvent', { eventType: 'orientationchange', eventProps: { orientation } });
	}

	/**
	 * @access private
	 */
	_onFullscreenChange (ev) {
		const isRealFullscreen = !!(document.fullscreenElement || document.fullScreenElement || document.mozFullscreenElement || document.mozFullScreenElement || document.webkitFullscreenElement || document.webkitFullScreenElement || document.msFullscreenElement);

		if (!isRealFullscreen && this._fullScreen) { // esc-key / close button / pan gesture was used
			this.cancelFullScreen(this._iframe);
		}

		ev && this.callChild('handleParentDocumentEvent', { eventType: 'fullscreenchange', eventProps: { isRealFullscreen } });
	}

	static onDOMContentLoaded (ev) {
		// just once
		if (BBIframeBridge.ready) {
			return;
		}
		BBIframeBridge.ready = true;

		if (document.removeEventListener) {
			document.removeEventListener('DOMContentLoaded', BBIframeBridge.onDOMContentLoaded, false);
		}

		window.bluebillywig = window.bluebillywig || {};
		window.bluebillywig.BBIframeBridges = window.bluebillywig.BBIframeBridges || [];

		// find BB iframes
		const bbRegex = /^(https?:|)(\/\/[a-z0-9.-]+\.)(bbvms\.com|mainroll\.com)\/(\w+)\/(\w+)/i;
		const iframes = document.querySelectorAll('iframe');
		iframes.forEach((currentValue, currentIndex, listObj) => {
			const match = currentValue.src && currentValue.src.match(bbRegex);
			if (match !== null && match.length > 1 || true) {
				// create bridge
				const bridge = new BBIframeBridge(currentValue);
				window.bluebillywig.BBIframeBridges.push(bridge);
			}
		});
	}

	static bootstrap () {
		// just once
		if (BBIframeBridge.bootstrapped) {
			return;
		}
		BBIframeBridge.bootstrapped = true;

		// Catch cases where bootstrap() is called after the browser event has already occurred.
		if (document.readyState === 'complete') {
			// Handle it asynchronously
			setTimeout(BBIframeBridge.onDOMContentLoaded, 1);
		} else {
			// Standards-based browsers support DOMContentLoaded
			document.addEventListener('DOMContentLoaded', BBIframeBridge.onDOMContentLoaded, false);

			// A fallback to window.onload that will always work
			window.addEventListener('load', BBIframeBridge.onDOMContentLoaded, false);
		}
	}
}

export { BBIframeBridge as default };
