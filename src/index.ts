// profile-switch — omp 配置档案（profile）切换扩展
//
// 把 ~/.omp/agent/config.yml 的完整快照保存为命名档案（~/.omp/agent/profiles/<名字>.yml），
// 在档案之间一键切换。切换时先把"当前正在生效的 config.yml"回写到它所属的档案，
// 再把目标档案写入 config.yml —— 因此两套配置完全独立、互不覆盖，任何一边的修改都不会丢。
//
// 斜杠命令：
//   /profile                 交互式选择档案并切换（TUI 下）
//   /profile list            列出全部档案（★ 为当前生效）
//   /profile save <名字>      把当前配置快照保存为指定档案（不动当前生效状态）
//   /profile switch <名字>    切换到指定档案
//   /profile next            循环切换到下一个档案
//   /profile show [名字]      查看档案的关键模型配置
//   /profile edit [名字]      用系统文本编辑器打开档案文件（macOS）
//   /profile delete <名字>    删除档案（当前生效的档案不允许删）
//
// 注意：切换后目标档案的默认模型会即时套用到当前会话（子代理等其余角色需重启 omp 完整生效）。
//       切换前的 config.yml 总会额外备份到 config.yml.pre-switch.bak，以防意外。

interface NotifyUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
}

interface ExtCtx {
	ui: NotifyUI;
	hasUI: boolean;
	mode: string;
	isIdle?: () => boolean;
	modelRegistry?: { find(provider: string, modelId: string): unknown };
}

interface ProfileSwitchApi {
	zod?: Record<string, unknown>;
	logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
	on(event: string, handler: (event: { reason?: string }, ctx: ExtCtx) => void): void;
	setModel(model: unknown): Promise<boolean>;
	setThinkingLevel(level: string): void;
	registerCommand(
		name: string,
		opts: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string }> | null;
			handler: (args: string, ctx: ExtCtx) => Promise<void>;
		},
	): void;
	registerTool(tool: Record<string, unknown>): void;
	exec(command: string, args: string[], options?: Record<string, unknown>): Promise<unknown>;
}

// Bun 同时支持 ESM 下的 getBuiltinModule / require，双保险兜底
function builtin<T = Record<string, unknown>>(name: string): T {
	const p = process as unknown as { getBuiltinModule?: (id: string) => unknown };
	if (typeof p.getBuiltinModule === "function") return p.getBuiltinModule(name) as T;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (globalThis as any).require(name) as T;
}

const { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readdirSync } =
	builtin<typeof import("node:fs")>("node:fs");
const path = builtin<typeof import("node:path")>("node:path");
const os = builtin<typeof import("node:os")>("node:os");

const AGENT_DIR = process.env.OMP_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
const CONFIG_FILE = path.join(AGENT_DIR, "config.yml");
const PROFILES_DIR = path.join(AGENT_DIR, "profiles");
const ACTIVE_FILE = path.join(PROFILES_DIR, ".active");
const BACKUP_FILE = path.join(AGENT_DIR, "config.yml.pre-switch.bak");

const SUBCOMMANDS = ["list", "save", "switch", "next", "show", "edit", "delete"];

function profileFile(name: string): string {
	return path.join(PROFILES_DIR, `${name}.yml`);
}

// 档案名：去掉结尾 .yml；拒绝路径分隔符、隐藏名、超长名
function sanitizeName(raw: string): string {
	const name = raw.trim().replace(/\.ya?ml$/i, "").trim();
	if (!name) throw new Error("档案名不能为空");
	if (name.startsWith(".") || /[\\/]/.test(name) || name.length > 80) {
		throw new Error(`非法档案名：${raw}`);
	}
	return name;
}

function readActive(): string | null {
	try {
		const name = readFileSync(ACTIVE_FILE, "utf8").trim();
		return name && existsSync(profileFile(name)) ? name : null;
	} catch {
		return null;
	}
}

function writeActive(name: string): void {
	try {
		writeFileSync(ACTIVE_FILE, `${name}\n`, "utf8");
	} catch {
		// 标记失败不影响切换本身
	}
}

function atomicWrite(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.profile-switch.tmp`;
	writeFileSync(tmp, data, "utf8");
	renameSync(tmp, file);
}

function listProfiles(): string[] {
	try {
		if (!existsSync(PROFILES_DIR)) return [];
		return readdirSync(PROFILES_DIR)
			.filter((f) => /\.ya?ml$/i.test(f))
			.map((f) => f.replace(/\.ya?ml$/i, ""))
			.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
	} catch {
		return [];
	}
}

// 从配置文本里粗提取 modelRoles.default / smol 和子代理覆盖数量（仅用于展示）
function scanKeyModels(text: string): { default?: string; smol?: string; overrides: number } {
	let top = "";
	let sawOverrides = false;
	let defaultModel: string | undefined;
	let smolModel: string | undefined;
	let overrides = 0;
	for (const raw of text.split(/\r?\n/)) {
		const topM = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):/);
		if (topM) {
			top = topM[1];
			sawOverrides = false;
			continue;
		}
		if (top === "modelRoles") {
			const m = raw.match(/^\s+(default|smol):\s*(.+?)\s*$/);
			if (m) {
				if (m[1] === "default") defaultModel = m[2];
				else smolModel = m[2];
			}
		}
		if (top === "task") {
			if (/^\s+agentModelOverrides:\s*$/.test(raw)) {
				sawOverrides = true;
				continue;
			}
			if (sawOverrides && /^\s+\S/.test(raw)) {
				if (/^\s{2}[\w-]+:/.test(raw)) sawOverrides = false;
				else if (/^\s{4}[\w-]+:\s*\S/.test(raw)) overrides++;
			}
		}
	}
	return { default: defaultModel, smol: smolModel, overrides };
}

function describeProfile(name: string): string {
	try {
		const s = scanKeyModels(readFileSync(profileFile(name), "utf8"));
		return `default=${s.default ?? "—"} smol=${s.smol ?? "—"} 子代理覆盖×${s.overrides}`;
	} catch {
		return "（无法读取）";
	}
}

function listMessage(): string {
	const names = listProfiles();
	if (names.length === 0) return "尚无配置档案。用 /profile save <名字> 把当前配置存为第一个档案。";
	const active = readActive();
	const lines = names.map((n) => `${n === active ? "★" : " "} ${n} — ${describeProfile(n)}`);
	return `配置档案（★=当前生效；switch 后主模型即时生效）：\n${lines.join("\n")}`;
}

// 切换核心：回写当前生效配置 → 写入目标档案 → 更新标记
function doSwitch(rawName: string): { message: string; switched: boolean; name: string } {
	const name = sanitizeName(rawName);
	const target = profileFile(name);
	if (!existsSync(target)) {
		throw new Error(`档案「${name}」不存在。现有：${listProfiles().join("、") || "（无）"}`);
	}
	if (!existsSync(CONFIG_FILE)) throw new Error(`未找到 ${CONFIG_FILE}`);
	const active = readActive();
	if (active === name) return { message: `已处于档案「${name}」，无需切换。`, switched: false, name };
	const current = readFileSync(CONFIG_FILE, "utf8");
	atomicWrite(BACKUP_FILE, current);
	let restored = "已把切换前的配置备份到 config.yml.pre-switch.bak";
	if (active) {
		atomicWrite(profileFile(active), current);
		restored = `当前配置已回写到档案「${active}」`;
	}
	atomicWrite(CONFIG_FILE, readFileSync(target, "utf8"));
	writeActive(name);
	return {
		message: `已切换到档案「${name}」，新会话将使用该档案配置。${restored}。`,
		switched: true,
		name,
	};
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

// 解析 "provider/model[:level]" 形式的模型引用
function parseModelRef(ref: string | undefined): { provider: string; modelId: string; level?: string } | null {
	if (!ref) return null;
	let rest = ref.trim().replace(/^["']|["']$/g, "");
	if (!rest) return null;
	let level: string | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon > 0) {
		const tail = rest.slice(colon + 1);
		if (THINKING_LEVELS.includes(tail)) {
			level = tail;
			rest = rest.slice(0, colon);
		}
	}
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const provider = rest.slice(0, slash);
	const modelId = rest.slice(slash + 1);
	if (!provider || !modelId) return null;
	return { provider, modelId, level };
}

// 把档案的默认模型（含思考等级）即时套用到当前会话；失败只提示，不影响文件切换
async function applyProfileModel(api: ProfileSwitchApi, ctx: ExtCtx, name: string): Promise<string> {
	try {
		const ref = scanKeyModels(readFileSync(profileFile(name), "utf8")).default;
		const parsed = parseModelRef(ref);
		if (!parsed) return "";
		if (ctx.isIdle && !ctx.isIdle()) {
			return "（代理正在输出，当前会话主模型暂不切换，重启 omp 后按新配置生效）";
		}
		const registry = ctx.modelRegistry;
		if (!registry || typeof registry.find !== "function") return "";
		const model = registry.find(parsed.provider, parsed.modelId);
		if (!model) {
			return `（注意：模型 ${parsed.provider}/${parsed.modelId} 暂不在注册表中（启动发现未完成，或 provider 的模型列表被覆盖），重启 omp 后按配置解析）`;
		}
		const ok = await api.setModel(model);
		if (!ok) {
			return `（注意：模型 ${parsed.provider}/${parsed.modelId} 认证未就绪，当前会话未切换主模型）`;
		}
		if (parsed.level) api.setThinkingLevel(parsed.level);
		return `当前会话主模型已即时切为 ${parsed.provider}/${parsed.modelId}${parsed.level ? `（思考：${parsed.level}）` : ""}。子代理等其余角色需重启 omp 完整生效。`;
	} catch (err) {
		return `（当前会话主模型应用失败：${(err as Error).message}；重启 omp 后按新配置生效）`;
	}
}

// 启动时按档案默认模型自动对齐当前会话：发现未完成（模型暂不在注册表）时自动重试数次
let startupModelRetries = 0;
async function applyProfileModelWithRetry(api: ProfileSwitchApi, ctx: ExtCtx, name: string): Promise<void> {
	try {
		const msg = await applyProfileModel(api, ctx, name);
		console.log(`[profile-switch] apply(${name}) -> ${(msg || "(empty)").slice(0, 160)}`);
		if (msg.includes("暂不在注册表") || msg.includes("下一回合会自动对齐")) {
			// 模型发现尚未完成或当前忙碌：稍后重试（最长约 10×2s）
			if (startupModelRetries < 10) {
				startupModelRetries++;
				setTimeout(() => void applyProfileModelWithRetry(api, ctx, name), 2000);
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					`档案「${name}」的默认模型迟迟未在注册表（provider 发现失败？），请手动 /model 选择。`,
					"warning",
				);
			}
			return;
		}
		if (msg && ctx.hasUI) ctx.ui.notify(msg, "info");
	} catch {
		// 自动对齐失败不影响会话
	}
}

async function switchAndApply(api: ProfileSwitchApi, ctx: ExtCtx, rawName: string): Promise<string> {
	const result = doSwitch(rawName);
	if (!result.switched) return result.message;
	const extra = await applyProfileModel(api, ctx, result.name);
	return [result.message, extra].filter(Boolean).join("\n");
}

async function doNext(api: ProfileSwitchApi, ctx: ExtCtx): Promise<string> {
	const names = listProfiles();
	if (names.length < 2) throw new Error(`至少需要两个档案才能循环切换（现有 ${names.length} 个）。`);
	const active = readActive();
	const idx = active ? names.indexOf(active) : -1;
	return switchAndApply(api, ctx, names[(idx + 1) % names.length]);
}

function doSave(rawName: string): string {
	const name = sanitizeName(rawName);
	if (!existsSync(CONFIG_FILE)) throw new Error(`未找到 ${CONFIG_FILE}`);
	mkdirSync(PROFILES_DIR, { recursive: true });
	atomicWrite(profileFile(name), readFileSync(CONFIG_FILE, "utf8"));
	return `当前配置已快照为档案「${name}」（${profileFile(name)}）。`;
}

function doShow(rawName: string): string {
	const name = rawName.trim() ? sanitizeName(rawName) : readActive() ?? "";
	if (!name) throw new Error("没有正在生效的档案，请指定名字：/profile show <名字>");
	if (!existsSync(profileFile(name))) {
		throw new Error(`档案「${name}」不存在。现有：${listProfiles().join("、") || "（无）"}`);
	}
	return `档案「${name}」：${describeProfile(name)}\n完整内容：${profileFile(name)}`;
}

async function doEdit(api: ProfileSwitchApi, ctx: ExtCtx, rawName: string): Promise<string> {
	const name = rawName.trim() ? sanitizeName(rawName) : readActive() ?? "";
	if (!name) throw new Error("没有正在生效的档案，请指定名字：/profile edit <名字>");
	const file = profileFile(name);
	if (!existsSync(file)) {
		throw new Error(`档案「${name}」不存在。现有：${listProfiles().join("、") || "（无）"}`);
	}
	if (process.platform === "darwin") {
		try {
			await api.exec("open", ["-t", file]);
			return `已在系统文本编辑器打开「${name}」。改完后 /profile switch ${name} 应用。`;
		} catch {
			// 打不开就退回提示路径
		}
	}
	ctx.ui.notify(`请手动编辑档案文件：${file}`, "info");
	return `档案文件路径：${file}`;
}

async function doDelete(ctx: ExtCtx, rawName: string): Promise<string> {
	const name = sanitizeName(rawName);
	const file = profileFile(name);
	if (!existsSync(file)) {
		throw new Error(`档案「${name}」不存在。现有：${listProfiles().join("、") || "（无）"}`);
	}
	if (readActive() === name) throw new Error(`「${name}」是当前生效的档案，先切换到别的档案再删除。`);
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("删除配置档案", `确定删除档案「${name}」？（config.yml 不受影响）`);
		if (!ok) return "已取消删除。";
	}
	unlinkSync(file);
	return `档案「${name}」已删除。`;
}

function output(ctx: ExtCtx, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

async function runSub(api: ProfileSwitchApi, ctx: ExtCtx, sub: string, rest: string): Promise<void> {
	try {
		switch (sub) {
			case "list":
				output(ctx, listMessage());
				break;
			case "save": {
				const name = await ensureSaveName(api, ctx, rest);
				output(ctx, name === null ? "已取消。" : doSave(name));
				break;
			}
			case "switch": {
				const name = await ensureSwitchName(api, ctx, rest);
				output(ctx, name === null ? "已取消。" : await switchAndApply(api, ctx, name));
				break;
			}
			case "next":
				output(ctx, await doNext(api, ctx));
				break;
			case "show":
				output(ctx, doShow(rest));
				break;
			case "edit":
				output(ctx, await doEdit(api, ctx, rest));
				break;
			case "delete":
				output(ctx, await doDelete(ctx, rest));
				break;
			default:
				output(ctx, usage(), "warning");
		}
	} catch (err) {
		output(ctx, `[profile-switch] ${(err as Error).message}`, "error");
	}
}

// 返回档案名；用户取消选择时返回 null
async function ensureSaveName(api: ProfileSwitchApi, ctx: ExtCtx, rest: string): Promise<string | null> {
	let name = rest.trim();
	if (!name && ctx.hasUI) {
		const typed = await ctx.ui.input("保存当前配置为新档案", "输入档案名，如：工作日配置");
		if (!typed) return null;
		name = typed;
	}
	if (!name) throw new Error("用法：/profile save <名字>");
	return name;
}

async function ensureSwitchName(api: ProfileSwitchApi, ctx: ExtCtx, rest: string): Promise<string | null> {
	let name = rest.trim();
	if (!name && ctx.hasUI) {
		const names = listProfiles();
		if (names.length === 0) throw new Error("尚无档案，先用 /profile save <名字> 创建。");
		const picked = await ctx.ui.select("切换到哪个配置档案？", names);
		if (!picked) return null;
		name = picked;
	}
	if (!name) throw new Error("用法：/profile switch <名字>");
	return name;
}

function usage(): string {
	return [
		"用法：",
		"  /profile                交互式选择并切换",
		"  /profile list           列出档案",
		"  /profile save <名字>    快照当前配置为档案",
		"  /profile switch <名字>  切换到档案",
		"  /profile next           循环切换",
		"  /profile show [名字]    查看档案要点",
		"  /profile edit [名字]    编辑档案文件",
		"  /profile delete <名字>  删除档案",
		"切换后主模型即时生效，子代理等角色重启 omp 后完整生效。",
	].join("\n");
}

// /profile 无参数时：TUI 下弹选择器（档案 + 快照入口）；无 UI 时打印列表
async function interactiveRoot(api: ProfileSwitchApi, ctx: ExtCtx): Promise<void> {
	if (!ctx.hasUI) {
		output(ctx, listMessage());
		return;
	}
	const names = listProfiles();
	const SAVE_LABEL = "＋ 把当前配置保存为新档案…";
	const picked = await ctx.ui.select(
		"配置档案（重启 omp 后生效）",
		[...names, SAVE_LABEL],
	);
	if (!picked) return;
	// 统一走 runSub（内含 try/catch 与 doSave/doSwitch 调用），避免分叉出旧逻辑
	await runSub(api, ctx, picked === SAVE_LABEL ? "save" : "switch", picked === SAVE_LABEL ? "" : picked);
}

export default function profileSwitch(pi: ProfileSwitchApi): void {
	console.log("[profile-switch] factory start");
	let loadedOk = false;
	try {
		loadedOk = typeof pi?.registerCommand === "function" && typeof pi?.on === "function";
	} catch (e) { console.log("[profile-switch] factory health err:", String(e)); }
	console.log("[profile-switch] factory health: registerCommand=" + (typeof pi?.registerCommand) + " on=" + (typeof pi?.on) + " loadedOk=" + loadedOk);
	pi.registerCommand("profile", {
		description: "切换 omp 配置档案（config.yml 快照）",
		getArgumentCompletions: (prefix: string) => {
			const items = [...SUBCOMMANDS, ...listProfiles()].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtCtx) => {
			try {
				const trimmed = args.trim();
				if (!trimmed) {
					await interactiveRoot(pi, ctx);
					return;
				}
				const sp = trimmed.indexOf(" ");
				const sub = (sp === -1 ? trimmed : trimmed.slice(0, sp)).trim();
				const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
				if (SUBCOMMANDS.includes(sub)) {
					await runSub(pi, ctx, sub, rest);
					return;
				}
				// 首词不是子命令：当作档案名直接切换（/profile 节假日）
				if (listProfiles().includes(sub) && !rest) {
					await runSub(pi, ctx, "switch", sub);
					return;
				}
				output(ctx, usage(), "warning");
			} catch (err) {
				// 兜底：任何未捕获异常都必须可见，不允许静默失败
				output(ctx, `[profile-switch] ${(err as Error).message}`, "error");
			}
		},
	});

	// 每次会话开始时重置"本会话已对齐"标记；startup 时尝试把档案默认模型套用当前会话
	let alignedCurrentSession = false;
	pi.on("session_start", (event, ctx) => {
		alignedCurrentSession = false;
		// 诊断：打印所有 session_start reason；对齐仅在非恢复场景执行
		console.log(`[profile-switch] session_start reason=${String(event.reason)} hasUI=${!!ctx.hasUI}`);
		if (event.reason === "resume" || event.reason === "fork") return;
		try {
			const active = readActive();
			if (ctx.hasUI) {
				ctx.ui.notify(
					active ? `配置档案：${active}` : "profile-switch 已加载，尚无档案（/profile save <名字> 创建）",
					"info",
				);
			}
			if (active && existsSync(CONFIG_FILE)) {
				startupModelRetries = 0; // 每次重启重置重试计数
				void applyProfileModelWithRetry(pi, ctx, active);
			} else {
				console.log(`[profile-switch] skip align: active=${String(active)} cfgExists=${existsSync(CONFIG_FILE)}`);
			}
		} catch (e) {
			console.log(`[profile-switch] session_start err: ${(e as Error).message}`);
		}
	});

	// 兜底：startup 事件里 setModel 可能因会话尚未就绪而不生效，
	// 在新会话第一个回合前再对齐一次（成功后本会话不再重复执行）
	pi.on("turn_start", (_event, ctx) => {
		if (alignedCurrentSession) return;
		try {
			const active = readActive();
			if (active && existsSync(CONFIG_FILE)) {
				alignedCurrentSession = true;
				void applyProfileModelWithRetry(pi, ctx, active);
			}
		} catch {
			// 兜底失败不影响回合
		}
	});

	// 注册一个模型可调用的工具：让代理能按自然语言指令切换/保存/列出档案
	try {
		const z = pi.zod;
		if (z && typeof (z as { object?: unknown }).object === "function") {
			pi.registerTool({
				name: "switch_profile",
				label: "Switch Profile",
				description:
					"切换 omp 配置档案（config.yml 的命名快照）。action=list 列出档案；action=switch 切换到 name 指定的档案（默认模型即时套用当前会话，其余角色重启 omp 生效）；action=save 把当前配置快照为 name 档案。",
				parameters: (z as {
					object: (shape: unknown) => unknown;
					enum: (values: string[]) => unknown;
					string: () => { describe(hint: string): unknown };
				}).object({
					action: (z as unknown as { enum: (v: string[]) => unknown }).enum(["list", "switch", "save"]),
					name: (z as unknown as { string: () => { describe(hint: string): unknown } }).string()
						.describe("档案名，switch/save 时必填"),
				}),
				approval: "write",
				async execute(
					_toolCallId: string,
					params: { action: "list" | "switch" | "save"; name?: string },
					_signal: unknown,
					_onUpdate: unknown,
					toolCtx: ExtCtx,
				) {
					let text: string;
					try {
						if (params.action === "list") text = listMessage();
						else if (params.action === "switch") text = await switchAndApply(pi, toolCtx, params.name ?? "");
						else text = doSave(params.name ?? "");
					} catch (err) {
						text = `失败：${(err as Error).message}`;
					}
					return { content: [{ type: "text", text }], details: { action: params.action } };
				},
			});
		}
	} catch (err) {
		pi.logger?.warn(`[profile-switch] 工具注册失败：${(err as Error).message}`);
	}
}
