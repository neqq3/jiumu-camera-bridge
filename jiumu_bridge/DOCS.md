<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Home Assistant OS 加载项

本加载项处于 experimental 阶段，尚未在 HAOS Supervisor 实机验证。amd64 Docker 验证不能替代 HAOS 安装验证。

本地安装：将本仓库的 `jiumu_bridge` 目录复制到 HAOS 的 `/addons/jiumu_bridge/`，确保其中存在 `config.yaml`。刷新本地应用 / 加载项列表，安装 Jiumu Local Bridge，启动并打开 Web UI。

仓库根目录已有 `repository.yaml`，公开发布后可以将该 Git 仓库 URL 添加到应用商店。私有仓库阶段请使用本地安装方式；当前不承诺商店一键安装已验证。

1. 设备先在九目智联完成 Wi-Fi 配网和账号绑定。
2. 在桥接 Web UI 填账号密码，选择自己的摄像头并保存。
3. 画面在线后填写 HAOS 主机的局域网 IP，生成 RTSP / Frigate 配置。

Ingress 通过 HA 认证；直连管理端口被拒绝。RTSP 使用独立本地凭据，默认端口 18554，可在加载项配置中调整。设备连接参数保存于 `/data`，加载项备份含敏感信息。

本加载项提供音视频，不负责人员识别、录像或自动创建 HA 实体。只看画面可用 Generic Camera；检测和录像使用 Frigate 及其 HA 集成。首次账号导入会连接厂商服务；摄像头自身是否联网尚未隔离验证。

参考：[HA 应用仓库](https://developers.home-assistant.io/docs/apps/repository/)、[本地应用教程](https://developers.home-assistant.io/docs/apps/tutorial/)、[Frigate HA 集成](https://docs.frigate.video/integrations/home-assistant/)。
