<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 云端构建和镜像安装

Docker 与 HAOS 使用同一个多架构镜像，安装主机负责运行，不需要现场编译。GitHub Actions 的 `images.yml` 在 GitHub 托管的 amd64、arm64 主机分别构建默认 Dockerfile，不使用家庭 NAS、HAOS 或自托管 runner。

每个架构都先做空数据安装、RTSP 子进程故障恢复、容器重启和合成音视频回归。测试容器使用 `network=none`，不访问摄像头、家庭网络或厂商账号。构建作业最多 25 分钟，测试有独立时限，失败日志保留 14 天。

分支构建通过后产生 `sha-完整提交号` 镜像，两种架构全部通过后才创建统一清单。发布 Git 标签不触发重建，避免把已经验证的版本替换为另一个摘要。`compose.yaml` 和加载项的 `image` 指向 GHCR，多架构清单会自动选择处理器架构。开发者仍可使用 `compose.build.yaml` 自行构建。

开发版本也可通过 `promote.yml` 填入成功的构建 run ID，直接将已测试的相同镜像摘要标记为源码配置中的 `X.Y.Z-dev.N`。它会核对工作流、提交、完成状态与摘要，不重新构建，不允许覆盖指向其他摘要的已有版本，也不更改仓库或镜像可见性。

仓库、GHCR 镜像和 [0.1.0-dev.2 预发布](https://github.com/neqq3/jiumu-camera-bridge/releases/tag/v0.1.0-dev.2)已于 2026-10-14 公开。镜像允许匿名拉取，Docker 和 HAOS 用户无需 GitHub 账号或令牌；这是开发预览，仍有摄像头偶发断流和自动重连，不能当作稳定版。不要将 GitHub 凭据填写到九目账号表单。

`0.1.0-dev.2` 的[双架构构建](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38506380010)与[版本标记](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38507413905)均已成功。两个架构分别通过 4 项安装恢复检查、70 项回归，零失败、零跳过；新增检查覆盖端口被其他服务占用、释放后自动恢复。HAOS 默认 RTSP 端口改为 19554，已有安装请同步修改加载项选项。

```text
ghcr.io/neqq3/jiumu-camera-bridge:0.1.0-dev.2
sha256:53632d9b97b4c4ec5ea953a3353ef768cc93e88cb7ee45b21013474f664b9b08
```

新版[对应源码收集](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38508032947)也已成功，附件 `runtime-sources-0.1.0-dev.2.tar.gz` 和校验文件已随该版本公开，SHA-256 为 `45edb8c3b6c813cceceba3ebe82fcaef404f519a957c220fad4c688c8cd78275`。收集和存储均在 GitHub 进行，没有在 NAS 或 HAOS 编译。

公开后的实际安装也已通过：Linux amd64 主机使用空 Docker 凭据配置匿名拉取，镜像摘要与上表一致；空数据启动、RTSP 子进程中断恢复、端口占用后的恢复、容器重启保留凭据四项检查均通过，临时容器和数据卷已清理。HAOS amd64 从该公开仓库直接安装预构建 dev.2，Supervisor 安装退出 0，Ingress、真实账号设备列表和重启检查通过。两条路线都没有在用户主机编译。HAOS 新实例保持空摄像头配置，已有主桥接继续取流；这些安装结果不替代长时间媒体验收。

本次 NAS 首次下载较慢，原 300 秒、900 秒测试客户端分别超时；保留失败记录后，由有 1800 秒上限的客户端接续同一层下载并完成验证。下载慢不等于账号或镜像权限错误；可先查看实际 `docker pull` 输出，勿直接更改整个主机的镜像源或网络设置。

下面保留首版镜像及其对应源码记录；不同版本的源码材料需与各自镜像匹配，不能用首版材料冒充新版材料。

2026-10-14 已完成[首次双架构构建](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38441178397)：两个架构分别通过 3 项安装恢复检查及 70 项回归，零失败、零跳过。[开发版发布](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38442548312)直接沿用这次构建的摘要：

```text
ghcr.io/neqq3/jiumu-camera-bridge:0.1.0-dev.1
sha256:88a919354f37bcc811538810572fe695c95f3e1eef539039e084267b4b82337e
```

镜像包含 Node 24.21.0、go2rtc 1.9.14、Debian FFmpeg 5.1.9-0+deb12u1。它证明云端构建和隔离运行成功，不表示已经完成从 GHCR 到 HAOS 的拉取更新或真实摄像头长测。

`source-bundle.yml` 从这份镜像的两个架构读取实际包清单，收集准确版本的 Debian 源码、Node 源码、go2rtc 源码及其依赖，并保存校验和。[首版收集](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38504569522)已完成 213 个 Debian 源码包。dev.1 是历史调试版本；日常试用请选择具有公开对应源码附件的 dev.2。

离线调试可用 `export-dev.yml` 导出已经构建、指定摘要的镜像，不重新编译。公开前曾将校验后的 dev.1 amd64 导出包导入 NAS，三个断网安装恢复检查通过，临时容器和数据卷已清理。这个历史 `docker load` 测试与公开后的匿名下载验证分开记录。

发布前核对：

1. Actions 中两个架构及清单作业均通过，下载本次 `image-results-*` 记录，核对镜像摘要。
2. 记录实际 Node、go2rtc、FFmpeg 构建信息、Debian 二进制和对应源码包版本、镜像内许可文本。流水线自动导出这些清单。
3. 对外分发前，按实际依赖准备对应源码及许可材料并与该版本长期保存。14 天 Actions 日志与版本清单不是对应源码分发方案，也不代替这一步。仓库和镜像的可见性独立核对。
4. 用预构建镜像验证 Docker 拉取安装、HAOS 更新与 Ingress；真机兼容性和稳定性单独记录，云端模拟测试不能替代它们。

参考：[Docker 多架构 Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)、[HA 加载项镜像配置](https://developers.home-assistant.io/docs/apps/configuration/)、[GHCR 权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
