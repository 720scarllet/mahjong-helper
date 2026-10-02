# 雀魂助手

Windows x64 桌面助手，支持三麻、四麻。左右两个独立悬浮窗显示牌河、未见牌、动作建议和牌型候选。

## 配置与启动

1. 使用 Windows 10／11 x64，解压项目到可写目录。
2. 双击 `setup.cmd`。配置窗口会准备 Edge、便携 Node.js、Go、Python、推理依赖和两份模型，并构建桌面程序。首次运行需要联网和约 4 GB 可用空间；缺少 Edge 时使用系统 Winget 安装，缺少 Visual C++ 运行库时可能出现系统权限提示。
3. 配置完成后点击“启动助手”，或运行 `release/win-unpacked/Mahjong Helper Overlay.exe`。
4. 选择区服后打开游戏。默认使用专用 Edge，入口为 <https://game.maj-soul.com/1/>。

设置中的“贴合游戏布局”会排列左右窗口与专用 Edge。`Ctrl+Alt+M` 恢复悬浮窗及鼠标交互。

Windows／Steam 客户端可在设置中开启客户端接入；浏览器扩展的安装步骤见 [extension/README.md](extension/README.md)。客户端接入仍需实际环境验证。

## 开发

配置成功后，工具保存在 `tools/`，模型与推理环境保存在 `vendor/mortal/`。

```powershell
$env:PATH="$PWD/tools/node-v24.12.0-win-x64;$PWD/tools/go/bin;$env:PATH"
& tools/node-v24.12.0-win-x64/npm.cmd test
& tools/node-v24.12.0-win-x64/npm.cmd start
& tools/go/bin/go.exe -C engine build -o ../bin/overlay-engine.exe ./cmd/overlay-engine
& tools/node-v24.12.0-win-x64/npm.cmd run build
```

仅配置环境、不构建：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -SkipBuild`。

## 上传 Git

将本目录作为仓库根目录。`.gitignore` 已排除模型、运行环境、依赖、缓存、日志和构建产物；保留源码、测试、配置脚本、锁文件与许可证。配置脚本可重新生成运行所需文件。

动作模型来自 [Akagi-MjaiBot-Mortal v0.1.0](https://github.com/shinkuan/Akagi-MjaiBot-Mortal/releases/tag/v0.1.0) 的社区公开权重，并非官方在线 Mortal。训练来源和实战强度尚未核实；牌型候选与鸣牌比较使用牌效分析。第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`npm test` 覆盖助手的协议、状态、模型动作校验、牌效接口和浏览器接入。原始 Go 库中部分策略排序测试仍与其当前实现不一致。
