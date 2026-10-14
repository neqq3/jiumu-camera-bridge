<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 云端构建和镜像安装

Docker 与 HAOS 使用同一个多架构镜像，安装主机负责运行，不需要现场编译。GitHub Actions 的 `images.yml` 在 GitHub 托管的 amd64、arm64 主机分别构建默认 Dockerfile，不使用家庭 NAS、HAOS 或自托管 runner。

每个架构都先做空数据安装、RTSP 子进程故障恢复、容器重启和合成音视频回归。测试容器使用 `network=none`，不访问摄像头、家庭网络或厂商账号。构建作业最多 25 分钟，测试有独立时限，失败日志保留 14 天。

分支构建通过后产生 `sha-完整提交号` 镜像。推送与加载项 `version` 相同的 `v版本号` Git 标签，可构建版本镜像；两种架构全部通过后才创建统一标签。`compose.yaml` 和加载项的 `image` 指向 GHCR，多架构清单会自动选择处理器架构。开发者仍可使用 `compose.build.yaml` 自行构建。

开发版本也可通过 `promote.yml` 填入成功的构建 run ID，直接将已测试的相同镜像摘要标记为源码配置中的 `X.Y.Z-dev.N`。它会核对工作流、提交、完成状态与摘要，不重新构建，不允许覆盖指向其他摘要的已有版本，也不更改仓库或镜像可见性。

当前仓库和镜像保持私有，`0.1.0-dev.1` 是开发候选，不是已公开的稳定版本。流水线成功、镜像存在和下载权限是安装前提。私有镜像需要 GHCR 读取权限，不能把此阶段称为普通用户免认证安装；公开发布后的加载项才适合在商店直接安装。不要将 GitHub 凭据填写到九目账号表单。

2026-10-14 已完成[首次双架构构建](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38441178397)：两个架构分别通过 3 项安装恢复检查及 70 项回归，零失败、零跳过。[开发版发布](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38442548312)直接沿用这次构建的摘要：

```text
ghcr.io/neqq3/jiumu-camera-bridge:0.1.0-dev.1
sha256:88a919354f37bcc811538810572fe695c95f3e1eef539039e084267b4b82337e
```

镜像包含 Node 24.21.0、go2rtc 1.9.14、Debian FFmpeg 5.1.9-0+deb12u1。它证明云端构建和隔离运行成功，不表示已经完成从 GHCR 到 HAOS 的拉取更新或真实摄像头长测。

`source-bundle.yml` 从这份镜像的两个架构读取实际包清单，收集准确版本的 Debian 源码、Node 源码、go2rtc 源码及其依赖，并保存校验和。[本次收集](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38504569522)已完成 213 个 Debian 源码包，材料保存于未发布的开发版 Release 草稿；没有公开仓库或镜像。

私有调试可用 `export-dev.yml` 导出已经构建、指定摘要的镜像，不重新编译。2026-10-14 已将校验后的 amd64 导出包导入 NAS，三个断网安装恢复检查全部通过，临时容器和数据卷已清理。`docker load` 的成功不等于 Supervisor 已通过私有 GHCR 的下载认证；普通加载项安装、更新仍需要可访问的镜像。

发布前核对：

1. Actions 中两个架构及清单作业均通过，下载本次 `image-results-*` 记录，核对镜像摘要。
2. 记录实际 Node、go2rtc、FFmpeg 构建信息、Debian 二进制和对应源码包版本、镜像内许可文本。流水线自动导出这些清单。
3. 对外分发前，按实际依赖准备对应源码及许可材料并与该版本长期保存。14 天 Actions 日志与版本清单不是对应源码分发方案，也不代替这一步。仓库和镜像的可见性独立核对。
4. 用预构建镜像验证 Docker 拉取安装、HAOS 更新与 Ingress；真机兼容性和稳定性单独记录，云端模拟测试不能替代它们。

参考：[Docker 多架构 Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)、[HA 加载项镜像配置](https://developers.home-assistant.io/docs/apps/configuration/)、[GHCR 权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
