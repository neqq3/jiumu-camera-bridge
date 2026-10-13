<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 云端构建和镜像安装

Docker 与 HAOS 使用同一个多架构镜像，安装主机负责运行，不需要现场编译。GitHub Actions 的 `images.yml` 在 GitHub 托管的 amd64、arm64 主机分别构建默认 Dockerfile，不使用家庭 NAS、HAOS 或自托管 runner。

每个架构都先做空数据安装、RTSP 子进程故障恢复、容器重启和合成音视频回归。测试容器使用 `network=none`，不访问摄像头、家庭网络或厂商账号。构建作业最多 25 分钟，测试有独立时限，失败日志保留 14 天。

分支构建通过后产生 `sha-完整提交号` 镜像。推送与加载项 `version` 相同的 `v版本号` Git 标签，才会产生版本镜像；两种架构全部通过后才创建统一标签。`compose.yaml` 和加载项的 `image` 指向 GHCR，多架构清单会自动选择处理器架构。开发者仍可使用 `compose.build.yaml` 自行构建。

当前仓库和镜像保持私有，`0.1.0-dev.1` 是开发候选，不是已公开的稳定版本。流水线成功、镜像存在和下载权限是安装前提。私有镜像需要 GHCR 读取权限，不能把此阶段称为普通用户免认证安装；公开发布后的加载项才适合在商店直接安装。不要将 GitHub 凭据填写到九目账号表单。

发布前核对：

1. Actions 中两个架构及清单作业均通过，下载本次 `image-results-*` 记录，核对镜像摘要。
2. 记录实际 Node、go2rtc、FFmpeg 构建信息、Debian 二进制和对应源码包版本、镜像内许可文本。流水线自动导出这些清单。
3. 对外分发前，按实际依赖准备对应源码及许可材料并与该版本长期保存。14 天 Actions 日志与版本清单不是对应源码分发方案，也不代替这一步。仓库和镜像的可见性独立核对。
4. 用预构建镜像验证 Docker 拉取安装、HAOS 更新与 Ingress；真机兼容性和稳定性单独记录，云端模拟测试不能替代它们。

参考：[Docker 多架构 Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)、[HA 加载项镜像配置](https://developers.home-assistant.io/docs/apps/configuration/)、[GHCR 权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
