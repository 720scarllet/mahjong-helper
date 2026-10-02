# Third-Party Notices

- Analysis engine: EndlessCheng/mahjong-helper, MIT. The original source and license are preserved in engine/. The desktop JSON wrapper is in engine/cmd/overlay-engine/.
- Protocol reference: official Mahjong Soul client resources retrieved on 2026-10-01; bundled liqi.json resource prefix v0.11.243.w. Live action transform was independently checked in official v0.11.252.w/code.js.
- MahjongCopilot (latorc/MahjongCopilot, GPL-3.0) was consulted for architecture and reconnect protocol behavior. Its Python application, model adapters, and automation code are not included.
- Proxinject binaries are redistributed from MahjongCopilot's proxinject/ directory, under their accompanying Apache-2.0 license. Source project: https://github.com/PragmaTwice/proxinject . Original license is preserved in vendor/proxinject/LICENSE and in packaged resources/proxinject/LICENSE. These binaries are unmodified. They are only invoked when the user explicitly enables process capture in the application.
- Tile artwork: FluffyStuff/riichi-mahjong-tiles, CC0/public domain. https://github.com/FluffyStuff/riichi-mahjong-tiles . Original license is in ui/tiles/LICENSE.md.
- Lucide icons: ISC. https://lucide.dev . The bundled distribution and license are in ui/.
- Electron, chrome-remote-interface (MIT), protobufjs, http-mitm-proxy, @pondwader/socks5-server, and other npm dependency licenses are included in node_modules and the packaged application. Exact dependency versions are recorded in package-lock.json.

- Local neural policy: shinkuan/Akagi-MjaiBot-Mortal v0.1.0, AGPL-3.0. https://github.com/shinkuan/Akagi-MjaiBot-Mortal . Unmodified model.py, loader, online_status.py, Windows libriichi extensions, checkpoint files, and LICENSE are installed by scripts/setup.ps1 and redistributed as a separate Python subprocess in resources/mortal/. Download hashes are in scripts/runtime-manifest.json. Model sources remain available at that repository and its release archives. No online inference is enabled.
- Mortal / libriichi: Equim-chan/Mortal, AGPL-3.0-or-later. https://github.com/Equim-chan/Mortal . The community policy's checkpoint is not the author's official online model; training provenance and playing strength have not been established.
- Portable Python 3.12.10: PSF license, included in resources/mortal/runtime/LICENSE.txt. PyTorch (BSD), NumPy (BSD), Requests (Apache-2.0) and inference dependency notices are retained in their packaged dist-info directories. Exact deployed versions are pinned in scripts/requirements-mortal.txt.
