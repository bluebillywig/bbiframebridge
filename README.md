# bbiframebridge 🌉

This GitHub-hosted NPM package provides an iframe bridge, enabling you to communicate with Blue Billywig iframes (players) in your web app. 
Here’s how.

## Adding to your package.json 📦
```
        "dependencies": {
                "bbiframebridge": "https://github.com/bluebillywig/bbiframebridge"
        }
```

## Importing and bootstrapping 🥾
```
import BBIframeBridge from 'bbiframebridge';
BBIframeBridge.bootstrap();
```

## Usage
After bootstrapping the bridge already works for going fullscreen and for local storage.  

If you look up the bridge instance for an iframe you want to control (e.g. window.bluebillywig.BBIframeBridges[0] ), you can issue callChild commands (e.g. 'play', 'pause'), or callChildPromise commands when the return value matters (e.g. 'getDuration', 'getPlayoutData'). See [the player API](https://support.bluebillywig.com/player-api/methods/).
```
const br = bluebillywig.BBIframeBridges[0];
const playoutData = await br.callChildPromise('getPlayoutData');

// let the iframe suggest new dimensions
br.setIframeSize({ width: '100%', height: 480 }); // width is optional, be careful with 100%
```

### Child → parent resize event
Inside the iframe, send a `setIframeSize` message once the player has computed its preferred dimensions. The parent bridge will pick it up and apply the new size.

```js
// object payload (recommended)
window.parent.postMessage({
        methodName: 'setIframeSize',
        paramsJson: JSON.stringify([{ width: '100%', height: 480 }]) // width is optional, be careful with 100%
}, '*');

// legacy string payloads are still supported
window.parent.postMessage('setIframeSize {"width":"100%","height":480}', '*');
window.parent.postMessage('setIframeSize 100% 480', '*');
```

## Troubleshooting
If installing the bbiframebridge dependency fails -- ```npm install``` tries to build the package from source in your build environment -- you can always resort to including the pre-built stand-alone version:  
```
<script type="text/javascript" src="https://cdn.bluebillywig.com/scripts/bbiframebridge/latest/bbiframebridge-standalone.js"></script>
```

