# Bundled libraries

Copied unchanged so the app works offline, without a CDN.

| File | Library | Version | Licence | Source |
|---|---|---|---|---|
| fabric.min.js | Fabric.js | 5.3.1 (reports 5.3.0) | MIT | https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js |
| cropper.min.js, cropper.min.css | Cropper.js | 1.6.2 | MIT | https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/ |

Not bundled (too large; cached by the service worker the first time they are used):
the background-removal library and model, and the Google Fonts.
