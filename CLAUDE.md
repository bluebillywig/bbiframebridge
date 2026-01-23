# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run build              # Build main npm package (dist/bbiframebridge.js)
npm run build-standalone   # Build standalone browser bundle (dist/bbiframebridge-standalone.js)
npm run clean              # Clear Parcel cache
```

The `prepare` script runs `npm run build` automatically when the package is installed as a dependency.

## Architecture

BBIframeBridge enables communication between a parent page and Blue Billywig video player iframes via postMessage.

### Entry Points
- `src/index.js` - npm package entry, exports BBIframeBridge class
- `src/standalone.js` - CDN bundle entry, auto-bootstraps on load

### Core Class: BBIframeBridge (`src/BBIframeBridge.js`)

Single class handling all bridge functionality:

- **Handshake protocol**: Parent and child frames exchange `handshake`/`handshakeSucceeded` messages before communication
- **Method queuing**: `_queueChild`/`_queueParent` hold calls until handshake completes
- **Bidirectional RPC**: `callChild()`/`callParent()` send method calls via postMessage; `callChildPromise()` for async returns
- **localStorage proxy**: Parent stores data on behalf of sandboxed iframes
- **Fullscreen management**: Handles native fullscreen API with vendor prefixes, plus "fullbrowser" CSS-based fallback
- **Visibility tracking**: IntersectionObserver notifies iframe when it enters/leaves viewport

### Build System

Uses Parcel with two targets defined in `package.json`:
- `main`: CommonJS output for npm consumption
- `standalone`: Self-bootstrapping browser bundle for CDN
