# Vitrine for Windows

A download page and a Windows package for Vitrine. People download the app from the page, and it runs on their own PC with its own database.

| Folder | What it is |
| --- | --- |
| `site/` | The download page. It's static and is all that GitHub Pages publishes. |
| `app/` | The Vitrine source, including the owner setup rule. |
| `packaging/` | Builds the Windows zip. |

## Build the zip

You need Windows and Node 22.13 or newer.

```powershell
cd app
npm ci
npm test
cd ..
node packaging/build.mjs
```

This creates `dist/Vitrine-Windows-x64.zip` and updates `site/release.js` with the version, size and checksum.

## Test on another GitHub account

1. Create a **public** repository on that account, named `vitrine-windows`.
2. In `site/config.js`, set `githubRepo` to `THAT-USERNAME/vitrine-windows`. Leave `backHref` as `null`.
3. Commit and push this folder to `main`.
4. In the repository, go to **Settings > Pages** and set **Source** to **GitHub Actions**. Then run **Deploy download page to Pages** from the **Actions** tab if it hasn't already deployed.
5. Publish the zip. The tag must match the version in `site/release.js`:

   ```powershell
   gh release create v1.0.0 dist/Vitrine-Windows-x64.zip --repo THAT-USERNAME/vitrine-windows --title "Vitrine 1.0.0" --notes "Windows 10 or 11, 64-bit."
   ```

6. Open the published page and run through the checklist below.

### Checklist

- [ ] The button downloads the zip.
- [ ] After Extract All, "Start Vitrine" opens the browser, including through any SmartScreen warning.
- [ ] A phone on the same Wi-Fi sees "Finish setup on the computer" before the owner account exists.
- [ ] The PC can create the owner account, and the phone can then sign in.
- [ ] The address on the Today page works on a phone and shows a pairing code, and that code pairs the screen.
- [ ] Data is still there after closing the window and starting Vitrine again.
- [ ] Data is still there after deleting the app folder and extracting the zip again.

## Add it to the biography site

The biography repository needs only the page. The app stays in its own repository and release, so nothing from `app/` or `dist/` goes into it.

1. Publish a release from the repository you want to keep long term, as in steps 1 to 5 above.
2. Copy everything in `site/` to `biography/tools/vitrine/`.
3. In the copied `config.js`, set `githubRepo` to that repository and `backHref` to `'../index.html'`.
4. Add this card to `tools/index.html`, inside the tools grid:

   ```html
   <a class="tool-card" href="vitrine/index.html">
       <span class="ribbon">NEW</span>
       <div class="tool-icon"><i class="fas fa-display"></i></div>
       <h2>Vitrine</h2>
       <p>Digital signage that runs on your own PC. Build playlists, schedule them, and show them on any screen with a browser. Download for Windows.</p>
       <span class="tool-cta">Download for Windows <i class="fas fa-arrow-right"></i></span>
   </a>
   ```

The page has its own stylesheet and follows the site's saved light or dark theme, so it doesn't change anything else on the site.

## Release a new version

1. Raise `version` in `app/package.json`.
2. Run the build, then commit `site/release.js`.
3. Create a release with the matching tag, such as `v1.0.1`.
4. Copy the new `release.js` to `biography/tools/vitrine/` as well, once the page is there.

The page links to the exact version named in `release.js`, so publish the release before pushing the page.

## Known limits

- The zip isn't code-signed, so Windows SmartScreen may warn people before it runs.
- FFmpeg isn't included, so RTSP and RTMP cameras don't work unless the user installs it. Other content doesn't need it.
- Network traffic between devices is plain HTTP, so it's only suitable for networks people trust.
- `VITRINE_LOCAL_SETUP` limits owner setup to the PC. The launcher turns it on; Docker and server installs leave it off.
