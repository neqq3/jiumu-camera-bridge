<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Jiumu Camera Bridge

九目智联 A907-J 摄像头的实验性局域网音视频桥接。通过 Docker 或 Home Assistant OS 加载项运行，输出供 Frigate / Home Assistant 使用的 RTSP。运行不需要 Android、ADB、厂商 APP 或厂商原生 SDK。

[0.1.0-dev.2 开发预览已公开](https://github.com/neqq3/jiumu-camera-bridge/releases/tag/v0.1.0-dev.2)。Docker 和 HAOS 共用 GitHub Actions 构建的 amd64 / arm64 镜像，无需 GitHub 登录或现场编译。开始使用请看 [Docker 安装](docs/install.md)或 [HAOS 加载项安装](jiumu_bridge/DOCS.md)。目前仍是实验版，偶发断流和长时间稳定性尚未解决。

当前正式化基线是：**官方 APP 正常配网并绑定自己的账号 → 桥接登录账号、选择摄像头 → Frigate / HA**。先完成这条路线的安装、错误处理、稳定音视频与自动恢复验证。用户用现有手机配网，桥接主机可有线联网，不要求新增无线网卡、蓝牙或 SD 卡。无账号配对、单设备路由引导和完整离云保证属于后续可选能力，不作为基线安装的前置条件；现有局域网取流实现继续保留。

**Web 界面目前提供账号导入；无账号本地绑定已在单台真机上完成配网、设密、LAN 取流和 Frigate 恢复，仍是独立实验流程。** 尚未做成普通用户安装向导。同叫“A9”的摄像头可能使用完全不同的协议，目前只验证了 A907-J / HLP2P 类型 26。

```text
首次导入：用户账号密码 → 桥接 → 厂商 HTTPS / MQTT TLS → 选取自己的设备
日常取流：摄像头 → 局域网 HLP2P → 桥接 + FFmpeg / go2rtc → RTSP → Frigate / HA
```

| 能力 | 验证状态 |
| --- | --- |
| 账号登录、选设备，无需提取 APP 数据 | 已实测 |
| 纯 Node.js 取流、视频及麦克风、Docker 重启恢复 | Linux amd64 已实测 |
| H.264 / AAC RTSP、Frigate 解码及带声音录像 | 已实测；不是摄像头原生 RTSP |
| HAOS amd64 加载项 | 公开仓库直接安装 dev.2、启动、Ingress、账号设备列表与重启保留凭据通过；长期运行待验 |
| 云端 amd64 / arm64 镜像 | 两种架构构建、安装恢复及各 70 项回归通过；已公开开发预览 |
| 无账号 LAN 发现、AP 下发 Wi-Fi | 单台真机成功；首次配置仍需 Wi-Fi 配网助手 |
| AP 热点内无账号视频取流 | 研究中实际解码成功；未形成用户安装流程 |
| 无账号首次设密、配网后认证和取流 | 本地服务与单设备 DNS 引导已实测；无 SD 卡；未做成向导 |
| 摄像头关机后自动恢复 | 单台设备、一次按键关机/开机已实测；原密码恢复音视频与 Frigate |
| 完整外网隔离下的电气冷启动、全天稳定性 | 未验证 |

实验结果截至 2026-10-14。已完成官方 APP 绑定 → 桥接账号导入 → LAN 音视频 → Frigate 有声录像，并验证新桥接进程无需重新登录即可恢复。官方账号模式的独立 24 小时观察已提前失败退出，没有取得全天稳定性通过结果。后续真机保留官方账号设备身份，改用本地业务服务、SDK 本地地址和单摄像头 IPv4 外网限制；短时取流及一次按键关机/开机恢复成功，仍有断流、自动重连和 Frigate 短暂零帧。该隐私实验不能替代厂商联网基线的独立验收。详见 [真机流程与边界](docs/local-binding-service.md)。完整 WAN/IPv6 隔离和完全移除供电后的冷启动仍待验证。

## 使用

- [选择接入与联网方式：厂商共存、账号辅助后隔离、无账号研究路线](docs/connection-modes.md)
- [单设备 DNS 与路由方案](docs/router-routing.md)
- [本地绑定实验服务：实现、启动与验证边界](docs/local-binding-service.md)
- [Docker 安装](docs/install.md)
- [云端构建、镜像与发布状态](docs/releases.md)
- [Home Assistant OS 加载项](jiumu_bridge/DOCS.md)
- [Frigate / HA 接入](docs/integrations.md)
- [数据去向与隐私](docs/privacy.md)
- [协议研究与本地配对进度](docs/research/protocol.md)
- [验证记录与待办](docs/validation.md)
- [自启动、恢复与仅本地运行验证](docs/recovery.md)
- [来源、第三方组件和发布边界](docs/provenance.md)

本仓库同时放应用、部署配置和脱敏研究文档。`jiumu_bridge/` 是 Docker 构建目录，也作为 HAOS 加载项目录；无需维护两份桥接核心。HA 画面可用 Generic Camera，检测和录像可用现有 Frigate 集成；本项目没有另造 HA 自定义集成。

项目与九目智联、设备厂商、Home Assistant 或 Frigate 无隶属关系。品牌和型号仅用于说明兼容性。

## 许可证

项目代码、构建文件、配置示例及文档中的代码片段使用 **Apache-2.0**；原创文档正文使用 **CC BY 4.0**。允许合规商用，项目本身免费提供。第三方材料保留各自许可证。详见 [LICENSE](LICENSE)。

这里只发布互操作实现和整理后的结论，不附带原厂 APK / SDK / 固件、反编译输出、私人抓包、账号、设备密码或真实录像。
