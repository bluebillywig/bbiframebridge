/*
 * Copyright Blue Billywig 2023+
 * ISC License
 * author(s): J. Koppen (j.koppen --at-- bluebillywig.com)
 * language: ES6 (2015)
 */

class BBIframeBridge {
	/**
	 * constructor
	 * @param {Object} iframe optional, default null
	 */
	constructor (iframe = null) {
		this._iframe = iframe;
		this._iframeOrigin = '*';
		if (this._iframe && this._iframe.src) {
			const match = this._iframe.src.match(/^(https?:|)(\/\/[a-z0-9.-]+)\//i);
			if (match) {
				this._iframeOrigin = match[1] + match[2]; // e.g. 'https:' + '//demo.bbvms.com'
			}
		}

		this._queueChild = [];
		this._queueParent = [];
		this._inMemoryStorage = {};
		this._isectObserver = null;
		this._metaViewportLocked = false;
		this._metaViewportContent = '';
		this._oldStyle = null;
		this._handshakeSucceededChild = false;

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
			this._iframe?.contentWindow?.postMessage('handshake', '*'); // this._iframeOrigin);
		} catch (er) {
			console.warn('[BBIframeBridge] constructor failed to postMessage; ' + er);
		}

		if (window.IntersectionObserver) { // Direct support
			this._setupIsectObserver();
		} else { // No direct support; polyfill
			import('intersection-observer').then(() => {
				this._setupIsectObserver();
			}).catch(() => {
				console.warn('[BBIframeBridge] Failed to polyfill IntersectionObserver');
			});
		}
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
				window.parent.postMessage({ methodName, paramsJson }, '*');
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
		const childPromise = new Promise((resolve) => {
			const onMessage = (ev) => {
				if (ev?.data?.methodName === 'return' && ev.data.returnKey === methodName) {
					window.removeEventListener('message', onMessage); // mimic options.once
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
		return Promise.race([childPromise, localPromise]);
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

		return ret;
	}

	_setupIsectObserver () {
		this._isectObserver?.disconnect();
		if (this._iframe) {
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
	 * @access private
	 */
	_onMessage (ev) {
		if (ev) {
			if (typeof ev.data === 'string') { // legacy
				switch (ev.data) {
				case 'handshake': // "SYN"
					if (ev.source === this._iframe?.contentWindow) { // child
						try {
							this._iframe.contentWindow.postMessage('handshakeSucceeded', this._iframeOrigin);
						} catch (er) {
							console.warn('[BBIframeBridge] _onMessage failed to postMessage handshakeSucceeded; ' + er);
						}
					} else if (ev.source === window.parent) { // parent
						try {
							window.parent.postMessage('handshakeSucceeded', '*');
						} catch (er) {
							console.warn('[BBIframeBridge] _onMessage failed to postMessage handshakeSucceeded; ' + er);
						}
					}
					// eslint-disable-next-line no-fallthrough
				case 'handshakeSucceeded': // "ACK"
					if (ev.source === this._iframe?.contentWindow) { // child
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
					} else {
						console.warn(`[BBIframeBridge] _onMessage unknown source...`);
					}
					break;
				case 'fullbrowser':
					this.enterFullScreen(this._iframe); // this.enterFullBrowser(this._iframe);
					break;
				case 'fullbrowser-off':
					this.cancelFullScreen(this._iframe); // this.cancelFullBrowser(this._iframe);
					break;
				case 'fullscr':
					this.enterFullScreen(this._iframe);
					break;
				case 'cancelfullscr':
					this.cancelFullScreen(this._iframe);
					break;
				}
			} else if (
				typeof ev.data === 'object' && // modern
				typeof ev.data.methodName === 'string' && // valid
				ev.data.methodName.indexOf('_' !== 0) && // public
				typeof this[ev.data.methodName] === 'function' // existing
			) {
				let params = ev.data.params;
				try {
					params = JSON.parse(ev.data.paramsJson);
				} catch (er) {}
				if (ev.data.methodName !== 'return') { // return reserved for future use
					let returnValue;
					if (Array.isArray(params)) {
						returnValue = this[ev.data.methodName].apply(this, params);
					} else {
						returnValue = this[ev.data.methodName](params);
					}
					if (typeof returnValue !== 'undefined') {
						try {
							this._iframe?.contentWindow?.postMessage({methodName: 'return', returnKey: ev.data.methodName, returnValue}, this._iframeOrigin);
						} catch (_) {}
					}
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
