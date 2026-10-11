<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Jiumu Camera Bridge

九目智联 A907-J 摄像头的实验性局域网音视频桥接。通过 Docker 或 Home Assistant OS 加载项运行，输出供 Frigate / Home Assistant 使用的 RTSP。运行不需要 Android、ADB、厂商 APP 或厂商原生 SDK。

**目前可用流程需要已有九目账号和已绑定设备。无账号首次配对尚未打通。** 同叫“A9”的摄像头可能使用完全不同的协议，目前只验证了 A907-J / HLP2P 类型 26。

```text
首次导入：用户账号密码 → 桥接 → 厂商 HTTPS / MQTT TLS → 选取自己的设备
日常取流：摄像头 → 局域网 HLP2P → 桥接 + FFmpeg / go2rtc → RTSP → Frigate / HA
```

| 能力 | 验证状态 |
| --- | --- |
| 账号登录、选设备，无需提取 APP 数据 | 已实测 |
| 纯 Node.js 取流、视频及麦克风、Docker 重启恢复 | Linux amd64 已实测 |
| H.264 / AAC RTSP、Frigate 解码及带声音录像 | 已实测；不是摄像头原生 RTSP |
| HAOS 加载项 / aarch64 | 已准备源码及配置，尚未实机验证 |
| 无账号 LAN 发现、AP 下发 Wi-Fi | 研究中分别成功过；不构成完整配对 |
| AP 热点内无账号视频取流 | 研究中实际解码成功；未形成用户安装流程 |
| 无账号首次设密、配网后认证和取流 | 未完成 |
| 摄像头断外网后冷启动、全天稳定性 | 未验证 |

实验结果截至 2026-10-11。之前的取流成功发生在设备重置之前；之后的配对实验使测试设备回到配网状态，不能把历史成功理解为当前仍在线。

## 使用

- [选择接入与联网方式：厂商共存、账号辅助后隔离、无账号研究路线](docs/connection-modes.md)
- [单设备 DNS 与路由方案](docs/router-routing.md)
- [本地绑定实验服务：实现、启动与验证边界](docs/local-binding-service.md)
- [Docker 安装](docs/install.md)
- [Home Assistant OS 加载项](jiumu_bridge/DOCS.md)
- [Frigate / HA 接入](docs/integrations.md)
- [数据去向与隐私](docs/privacy.md)
- [协议研究与本地配对进度](docs/research/protocol.md)
- [验证记录与待办](docs/validation.md)
- [来源、第三方组件和发布边界](docs/provenance.md)

本仓库同时放应用、部署配置和脱敏研究文档。`jiumu_bridge/` 是 Docker 构建目录，也作为 HAOS 加载项目录；无需维护两份桥接核心。HA 画面可用 Generic Camera，检测和录像可用现有 Frigate 集成；本项目没有另造 HA 自定义集成。

项目与九目智联、设备厂商、Home Assistant 或 Frigate 无隶属关系。品牌和型号仅用于说明兼容性。

## 许可证

项目代码、构建文件、配置示例及文档中的代码片段使用 **Apache-2.0**；原创文档正文使用 **CC BY 4.0**。允许合规商用，项目本身免费提供。第三方材料保留各自许可证。详见 [LICENSE](LICENSE)。

这里只发布互操作实现和整理后的结论，不附带原厂 APK / SDK / 固件、反编译输出、私人抓包、账号、设备密码或真实录像。
