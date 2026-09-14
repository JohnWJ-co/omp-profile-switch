# omp-profile-switch

**omp 配置档案（Profile）切换扩展** —— 把 `config.yml` 快照为命名档案，在多套模型配置之间一键切换，主模型即时生效。

适用于 [omp](https://omp.sh)（oh-my-pi）v18+。

## 这是什么

omp 的模型配置（默认模型、思考等级、子代理模型覆盖等）都写在 `~/.omp/agent/config.yml` 里。想在"公司提供的模型"和"自己的模型"之间来回切换，就需要反复手改配置 —— 本扩展把这个过程变成一条命令：

```
/profile switch 工作日     # 切到公司模型配置
/profile switch 节假日     # 切回自己的模型配置
```

每套档案是 `config.yml` 的**完整独立快照**，互不影响；切换时会把当前正在生效的配置回写回它所属的档案，你在任何一边做过的调整都不会丢。

### 特性

- 📸 **快照档案**：`/profile save <名字>` 把当前配置存为命名档案，想建几套建几套
- ⚡ **切换即时生效**：切换后自动把目标档案的默认模型 + 思考等级套用到当前会话（子代理等角色重启后完整生效）
- 🔄 **双向回写**：切换时自动保存当前配置，两套档案永不互相覆盖
- 🧭 **循环切换**：`/profile next` 在所有档案间轮转
- 🚀 **启动自动对齐**：新会话（重启 / `/restart`）时自动把档案默认模型套用当前会话，不再被 omp"上次手工选的模型"恢复覆盖；模型发现未完成会自动重试（最长约 20s）
- 🩺 **漂移检测**：启动时发现 config.yml 与当前档案不一致（比如在 TUI 里手动选过模型）会给出提示
- 🛟 **兜底备份**：每次切换前把 config.yml 备份到 `config.yml.pre-switch.bak`
- 🤖 **可被代理调用**：注册 `switch_profile` 工具，直接说"切换到工作日配置"也行

## 安装

### 方式一：松散扩展文件（最简单）

把 `src/index.ts` 复制到 omp 的用户扩展目录：

```bash
mkdir -p ~/.omp/agent/extensions
cp src/index.ts ~/.omp/agent/extensions/profile-switch.ts
```

重启 omp 即自动加载。

### 方式二：作为插件包链接（推荐开发者）

```bash
# 在本仓库目录下执行
omp plugin link ./        # 或：omp install ./
```

本地安装是符号链接，改完代码重启 omp 即生效。用 `omp plugin list` 确认、`omp plugin doctor` 体检。

> ⚠️ **不要重复安装**：`方式一` 的松散文件和 `方式二` 的插件包会同时被 omp 发现，导致 `/profile` 命令注册冲突。二选一：如果用包安装，请先删除 `~/.omp/agent/extensions/profile-switch.ts`。

### 方式三：配置文件引用

在 `~/.omp/agent/config.yml` 中加：

```yaml
extensions:
  - /absolute/path/to/omp-profile-switch
```

### 验证

启动 omp 后输入 `/profile list`：

```
配置档案（★=当前生效；switch 后主模型即时生效）：
★ 默认 — default=p4/gpt-5.6-sol:high smol=codebuddy/kimi-k3-1:max 子代理覆盖×10
  全部hy4 — default=codebuddy/hy4-preview:high smol=codebuddy/kimi-k3-1:max 子代理覆盖×10
```

也可以在 TUI 里输入 `/extensions` 查看扩展加载状态（ID 为 `extension-module:profile-switch.ts`）。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/profile` | 弹出选择框：直接选档案切换，或"＋ 把当前配置保存为新档案…" |
| `/profile list` | 列出全部档案（★ 为当前生效，附各档案默认模型摘要） |
| `/profile save <名字>` | 把当前配置快照为指定档案（不改变当前生效状态） |
| `/profile switch <名字>` | 切换到指定档案（原配置先回写，主模型即时应用） |
| `/profile next` | 循环切换到下一个档案 |
| `/profile show [名字]` | 查看档案的关键模型配置（默认模型 / smol / 子代理覆盖数） |
| `/profile edit [名字]` | 用系统文本编辑器打开档案文件（macOS，缺省打开当前档案） |
| `/profile delete <名字>` | 删除档案（当前生效的档案不允许删，先切换走） |

- 名字支持中文、空格；首词不是子命令时会被当作档案名直接切换（`/profile 节假日` 等价于 `/profile switch 节假日`）
- 无 UI 的运行模式（`-p` 打印模式等）下，命令降级为纯文本输出，跳过所有交互对话框

### 典型工作流

```bash
# 1. 把当前配置（公司模型）存为"工作日"
/profile save 工作日

# 2. 切出一个新档案"节假日"（初始内容与当前相同）
/profile save 节假日

# 3. 编辑节假日档案，换成自己的模型（或直接改文件）
/profile edit 节假日

# 4. 应用（主模型立即生效；子代理模型覆盖重启 omp 后完整生效）
/profile switch 节假日
```

## 工作机制

### 存储布局

```
~/.omp/agent/
├── config.yml                    # 正在生效的配置（omp 读取的就是它）
├── config.yml.pre-switch.bak     # 每次切换前的兜底备份（滚动覆盖）
└── profiles/
    ├── .active                   # 当前生效档案名
    ├── 工作日.yml                # 档案 = config.yml 的完整快照
    └── 节假日.yml
```

### 切换流程（`/profile switch X`）

1. 把当前 `config.yml` **回写**到此前生效的档案（你在该档案下的一切调整得以保留）
2. 当前 `config.yml` 备份到 `config.yml.pre-switch.bak`
3. 把档案 X 的内容写入 `config.yml`，更新 `.active` 标记
4. 解析档案 X 的 `modelRoles.default`（格式 `provider/model:思考等级`），通过 `pi.setModel()` / `pi.setThinkingLevel()` **即时套用到当前会话** —— 这一步只影响当前会话，不会写回配置文件

### 漂移检测与启动自动对齐

在 TUI 里手动选模型是 omp 的原生行为，会立刻写回 `config.yml`（`modelRoleStorage: global`），导致 config.yml 与当前档案出现"漂移"。漂移不是错误：下次切换时漂移内容会作为"当前配置"归档进当时的档案（快照语义）。

omp 在重启 / 开新会话时倾向于**恢复"上次手工选择的模型"**，这可能让切档案后默认模型仍是旧模型（例如"全部hy4"档案指纹正确写入 `default: codebuddy/hy4-preview`，重启后却落在上次手动选的 Google Gemini 上）。为此本扩展在新会话（`startup` / `new`）启动时**自动把档案的 `modelRoles.default` 套用到当前会话**：

- 目标模型已在注册表 → 立即 `setModel` + `setThinkingLevel`
- 暂未在注册表（provider 模型发现未完成）→ 每 2s 重试，最长约 20s，成功即对齐
- 首个回合前再做一次兜底对齐，确保会话就绪后模型正确
- `resume` / `fork`（恢复历史会话）不干预，尊重会话本身携带的模型

这样每次切档案后，主模型在新会话里都能稳定落在档案默认上。

## 注意事项

- **子代理等角色需重启**：`task.agentModelOverrides`、`modelRoles` 的其他角色在 omp 启动时读取，没有运行时 API，切换后需重启 omp 才完整生效。主模型（默认模型）是即时生效的。
- **切换后建议尽快重启**：正在运行的 omp 会话持有的设置若发生变化（如再次手动选模型），会按它内存里的状态写回 config.yml。
- **codebuddy 多账号插件的用户**：如果切换后 codebuddy 的模型列表只剩一个 `auto`，那是 `omp-codebuddy-oauth` 插件的模型发现机制所致 —— 模型列表来自 `/v3/config`，**不同账号返回不同列表**（个人账号通常只有 auto，企业账号才有完整模型组），且发现结果是"后到者整体替换"。默认模型指向 codebuddy 时会触发额外的凭据解析路径，可能用非企业账号重新发现。应对办法：
  - 重启 omp（启动发现固定用账号池第一个可用账号，failover 策略下即你的首选账号）
  - 或用 `/codebuddy-accounts list` 检查账号状态，移除不需要的个人账号
- **别在档案目录里手工放无关文件**：`profiles/` 下所有 `.yml` 都会被当作档案。

## 目录结构

```
omp-profile-switch/
├── package.json      # omp.extensions 指向 ./src/index.ts
├── README.md
├── LICENSE
└── src/
    └── index.ts      # 扩展源码（无第三方依赖，直接运行 TS）
```

扩展零依赖，只使用 Node 内置模块（`node:fs` / `node:path` / `node:os`），通过 `process.getBuiltinModule`（Bun）加载，兼容 ESM/CJS 两种加载方式。

## 卸载

```bash
# 松散文件方式
rm ~/.omp/agent/extensions/profile-switch.ts

# 插件包方式
omp plugin unlink omp-profile-switch   # 或删除 ~/.omp/plugins/ 下对应条目
```

档案数据（`~/.omp/agent/profiles/`）不会被删除，按需手动清理。

## 常见问题

**Q：切换后模型怎么没变？**
主模型即时生效的前提是目标模型在当前模型注册表中能找到。如果出现"模型不在注册表中"的提示，重启 omp 即可（新会话按 config.yml 解析）。

**Q：/profile switch 提示"已处于档案 X，无需切换"？**
当前生效档案就是 X。先 `switch` 到别的档案，或用 `/profile save` 把现在的配置快照为新档案。

**Q：重启后默认模型还是之前手动选的模型？**
新会话会由"启动自动对齐"自动套用当前档案的默认模型（最长约 20s 内）。若仍不对，用 `/profile list` 确认当前生效档案，并确认目标模型在 `/model` 注册表中存在。

**Q：想恢复某次切换前的配置？**
每次切换前都有 `~/.omp/agent/config.yml.pre-switch.bak`，直接拷回去即可。

**Q：omp 原生的 `--profile` 参数和这个是一回事吗？**
不是。`omp --profile <名字>` 是"隔离身份"（独立的会话/缓存/登录态目录），不切换模型配置。本扩展切的是同一身份下的模型配置档案。
