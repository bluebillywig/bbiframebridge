import BBIframeBridge from './BBIframeBridge';

// The bridge trusted `ev.source === iframe.contentWindow` and dispatched `this[methodName]`.
// ev.source cannot be forged, but it survives a navigation, so an iframe moved to a hostile origin
// after load kept its trusted source -- and every public method was reachable by name.

const IFRAME_ORIGIN = 'https://demo.bbvms.com';

// A stand-in for the child iframe's contentWindow; identity is all that matters to ev.source.
const makeIframe = (src = IFRAME_ORIGIN + '/p/default/c/123.html') => ({
	src,
	contentWindow: { postMessage: jest.fn(), name: 'child' },
	style: {}
});

const makeBridge = (iframe, enforceOrigin = false) => {
	const bridge = new BBIframeBridge(iframe);
	bridge._enforceOrigin = enforceOrigin;
	bridge._handshakeSucceededChild = true;
	bridge._handshakeSucceededParent = true;
	return bridge;
};

const childEvt = (bridge, data, origin = IFRAME_ORIGIN) =>
	({ data, source: bridge._iframe.contentWindow, origin });

describe('BBIframeBridge child->parent command dispatch', () => {
	let warn;
	let bridge;

	beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
	afterEach(() => {
		if (bridge) { bridge.exit(); bridge = null; }
		jest.restoreAllMocks();
	});

	it('derives the iframe origin from src and dispatches an allowlisted command', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe);
		expect(bridge._iframeOrigin).toBe(IFRAME_ORIGIN);

		bridge._onMessage(childEvt(bridge, {
			methodName: 'setIframeSize',
			paramsJson: JSON.stringify([{ height: '480px' }])
		}));

		expect(iframe.style.height).toBe('480px');
	});

	// setLocation assigns window.location.href -- a redirect / `javascript:` primitive that used to
	// be reachable by name from the child.
	it('refuses setLocation over postMessage even from the real child iframe', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe);
		const setLocation = jest.spyOn(bridge, 'setLocation').mockImplementation(() => {});

		bridge._onMessage(childEvt(bridge, {
			methodName: 'setLocation',
			paramsJson: JSON.stringify(['https://evil.test'])
		}));

		expect(setLocation).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('not callable from the child iframe'));
	});

	it.each(['exit', 'callParent', 'callChild'])('refuses %s over postMessage', (methodName) => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe);
		const spy = jest.spyOn(bridge, methodName).mockImplementation(() => {});

		bridge._onMessage(childEvt(bridge, { methodName, paramsJson: '[]' }));

		expect(spy).not.toHaveBeenCalled();
	});

	it('ignores messages from a window that is not the child iframe', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe);

		bridge._onMessage({
			data: { methodName: 'setIframeSize', paramsJson: JSON.stringify([{ height: '999px' }]) },
			source: { name: 'some-other-iframe' },
			origin: IFRAME_ORIGIN
		});

		expect(iframe.style.height).toBeUndefined();
	});

	it('does not throw on malformed data', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe);
		for (const data of [null, undefined, 42, [], {}, { methodName: 123 }, { methodName: null }]) {
			expect(() => bridge._onMessage(childEvt(bridge, data))).not.toThrow();
		}
	});
});

describe('BBIframeBridge origin re-validation', () => {
	let warn;
	let bridge;

	beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
	afterEach(() => {
		if (bridge) { bridge.exit(); bridge = null; }
		jest.restoreAllMocks();
	});

	// The scenario in the ticket: iframe.src mutated after load. ev.source still matches, so only a
	// per-message origin check catches it.
	it('drops a message whose origin no longer matches the iframe, under enforcement', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe, true);

		bridge._onMessage(childEvt(bridge, {
			methodName: 'setIframeSize',
			paramsJson: JSON.stringify([{ height: '480px' }])
		}, 'https://evil.test'));

		expect(iframe.style.height).toBeUndefined();
	});

	// Exact match, not substring: the classic subdomain trick.
	it('rejects an origin that merely has the iframe origin as a prefix', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe, true);

		bridge._onMessage(childEvt(bridge, {
			methodName: 'setIframeSize',
			paramsJson: JSON.stringify([{ height: '480px' }])
		}, IFRAME_ORIGIN + '.evil.test'));

		expect(iframe.style.height).toBeUndefined();
	});

	it('warns but still handles a mismatched origin in warn-only mode', () => {
		const iframe = makeIframe();
		bridge = makeBridge(iframe, false);

		bridge._onMessage(childEvt(bridge, {
			methodName: 'setIframeSize',
			paramsJson: JSON.stringify([{ height: '480px' }])
		}, 'https://evil.test'));

		expect(iframe.style.height).toBe('480px');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('warn-only mode'));
	});

	it('warns when iframe.src yields no usable origin', () => {
		bridge = makeBridge(makeIframe('/relative/player.html'));
		expect(bridge._iframeOrigin).toBe('*');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('inbound origin validation is disabled'));
	});
});

describe('BBIframeBridge callChildPromise', () => {
	let bridge;

	afterEach(() => {
		if (bridge) { bridge.exit(); bridge = null; }
		jest.restoreAllMocks();
	});

	it('resolves from the real child iframe', async () => {
		bridge = makeBridge(makeIframe());
		const pending = bridge.callChildPromise('getDuration');

		window.dispatchEvent(Object.assign(new Event('message'), {
			data: { methodName: 'return', returnKey: 'getDuration', returnValue: 42 },
			source: bridge._iframe.contentWindow,
			origin: IFRAME_ORIGIN
		}));

		await expect(pending).resolves.toBe(42);
	});

	// Previously the inner listener checked neither source nor origin, so any window on the page
	// could decide what this promise resolved to.
	it('ignores a "return" posted by another window', async () => {
		bridge = makeBridge(makeIframe());
		const pending = bridge.callChildPromise('getDuration');

		window.dispatchEvent(Object.assign(new Event('message'), {
			data: { methodName: 'return', returnKey: 'getDuration', returnValue: 'hijacked' },
			source: { name: 'evil-iframe' },
			origin: 'https://evil.test'
		}));

		// Falls through to the 240ms timeout default instead of taking the forged value.
		await expect(pending).resolves.toBeNull();
	});
});
