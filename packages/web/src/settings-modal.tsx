/**
 * Settings modal (antd Modal), aligned with manta-compare's latest implementation:
 * icon menu on the left + content area on the right; pane switching is managed by a
 * component-local controlled activeKey (no nested Router). Container padding is zeroed
 * → the settings shell (left menu + right content) fills the modal; the body is fixed
 * at 80vh and scrolls internally. The right side's title strip is a static in-flow bar
 * (.pc-settings-header) with the content area scrolling independently below it.
 * destroyOnHidden: each open remounts from the initial pane.
 */
import { useEffect, useState } from "react";
import {
  Button,
  ConfigProvider,
  Empty,
  Input,
  Menu,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Switch,
  Tag,
} from "antd";
import {
  ApiOutlined,
  CloseOutlined,
  EditOutlined,
  ExperimentOutlined,
  GithubOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  MessageOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import cx from "classnames";
import { menuSkinTheme } from "./menu-skin";
import { AgentIcon } from "./agent-icon";
import * as api from "./api";
import appIcon from "./assets/app-icon.png";
import pkg from "../package.json";

type Notify = (message: string, type?: "info" | "error") => void;

/** Unified settings-card shell shared by the watch and connector panes' card
 *  lists (32px icon + title/desc column + trailing toggle). */
const CARD =
  "flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3";

const TABS = [
  { key: "general", label: "记忆服务", icon: <ExperimentOutlined /> },
  { key: "watch", label: "记忆监听", icon: <ApiOutlined /> },
  { key: "connector", label: "连接器", icon: <LinkOutlined /> },
  { key: "about", label: "关于", icon: <InfoCircleOutlined /> },
];

export function SettingsModal({
  open,
  onClose,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onNotify: Notify;
}) {
  const [pane, setPane] = useState("general");

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      // antd v6 has built-in frosted masking: blur the page behind the overlay.
      mask={{ blur: true }}
      // Pure fade in/out instead of antd zoom: the glass layer lives inside the panel
      // (.pc-glass-modal ::before); an ancestor with a transform animation would make
      // it dormant, appearing only after the animation ends (flash when opening).
      // The motion CSS is in styles/antd.css (.pc-modal-fade-*).
      transitionName="pc-modal-fade"
      width={860}
      centered
      title={null}
      wrapClassName="pc-glass-modal"
      classNames={{ container: "overflow-hidden !p-0" }}
      styles={{ body: { height: "80vh", padding: 0, overflow: "hidden" } }}
    >
      <div className="flex h-full overflow-hidden *:min-h-0 *:min-w-0">
        {/* Left icon menu: antd Menu with controlled selectedKeys, sharing the Menu skin
            (menuSkinTheme + .pc-menu-skin, same as the sidebar). No background here —
            the frosted glass layer sits on the modal panel. */}
        <nav className="box-border h-full w-45 shrink-0 overflow-auto border-r border-line px-2 py-4">
          <ConfigProvider theme={menuSkinTheme}>
            <Menu
              mode="inline"
              selectedKeys={[pane]}
              onClick={({ key }) => setPane(key)}
              className="pc-menu-skin"
              items={TABS.map((tab) => ({
                key: tab.key,
                icon: tab.icon,
                label: tab.label,
              }))}
            />
          </ConfigProvider>
        </nav>

        {/* Right content area: static in-flow title strip (.pc-settings-header) + an
            independently scrolling area below (box-border: the project has no global
            border-box reset — no Tailwind preflight — so without it flex-1 + vertical
            padding would overflow by exactly the padding amount and clip the bottom
            of the scroll area). */}
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {/* pointer-events-none: clicks pass through to the Modal's close button (top-right of this strip). */}
          <div className="pc-settings-header pointer-events-none flex h-[54px] shrink-0 items-center px-6">
            <h3 className="m-0 text-md font-semibold">
              {TABS.find((t) => t.key === pane)?.label ?? "记忆服务"}
            </h3>
          </div>
          <div className="box-border min-h-0 min-w-0 flex-1 overflow-auto px-6 pt-4 pb-8">
            {pane === "about" ? (
              <AboutPane />
            ) : pane === "watch" ? (
              <WatchPane onNotify={onNotify} />
            ) : pane === "connector" ? (
              <ConnectorsPane onNotify={onNotify} />
            ) : (
              <GeneralPane onNotify={onNotify} />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 服务预设（对齐 joybuddy 模型配置的预设下拉交互）：命中预设自动填 Base URL 和协议，
 *  选「自定义」才手填。接入更多上游：往这里追加一条即可。baseUrl 为 null 的是「自定义」项。
 *  protocol: minimax = MiniMax 私有协议（LLM 走 mem0 minimax provider、embedding 经本地
 *  shim 转换）；openai = OpenAI 兼容协议（标准 /chat/completions + /embeddings 直连）。 */
const LLM_PRESETS = [
  {
    key: "minimax-cn",
    label: "MiniMax 国内",
    baseUrl: "https://api.minimax.cn/v1",
    protocol: "minimax" as const,
  },
  {
    key: "minimax-io",
    label: "MiniMax 海外",
    baseUrl: "https://api.minimax.io/v1",
    protocol: "minimax" as const,
  },
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai" as const,
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai" as const,
  },
  { key: "custom", label: "自定义", baseUrl: null, protocol: null },
];

/** 每种协议的 Embedding 模型默认值（与主进程 settings.ts 的 DEFAULTS 对齐）。 */
const EMBED_DEFAULTS: Record<"minimax" | "openai", string> = {
  minimax: "embo-01",
  openai: "text-embedding-3-small",
};

/** 由当前 baseUrl 反查命中的预设 key（未命中 → 「自定义」）。 */
function presetKeyFor(baseUrl: string): string {
  return (
    LLM_PRESETS.find((p) => p.baseUrl && p.baseUrl === baseUrl)?.key ?? "custom"
  );
}

/** 表单字段行（对齐 joybuddy 的 ModelForm）：label 在上、控件在下，desc 跟在 label 后。 */
function FormField({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-fg">
        {label}
        {desc && <span className="text-xs font-normal text-muted">{desc}</span>}
      </div>
      {children}
    </div>
  );
}

/** "Memory service" pane: an immediately-persisted storage-mode selector (local child
 *  service / user-deployed remote) + the model service shown as a card, editing opens a
 *  modal form with a preset dropdown and dirty-gated save that auto-closes on success.
 *  No enable toggle: every feature behind the service (project panel, search, watching,
 *  MCP) is core — the service connects whenever it's configured. */
function GeneralPane({ onNotify }: { onNotify: Notify }) {
  const [protocol, setProtocol] = useState<"minimax" | "openai">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  /** Edit-modal draft: null = closed. `original` is the baseUrl/model snapshot for dirty detection. */
  const [draft, setDraft] = useState<{
    protocol: "minimax" | "openai";
    baseUrl: string;
    model: string;
    embedModel: string;
    apiKey: string;
    apiKeyTouched: boolean;
  } | null>(null);
  const [original, setOriginal] = useState<{
    protocol: "minimax" | "openai";
    baseUrl: string;
    model: string;
    embedModel: string;
  } | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Memory storage: local child service (default) or a user-deployed remote service. */
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [hasRemoteToken, setHasRemoteToken] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setProtocol(s.provider);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
        setEmbedModel(s.embedModel);
        setHasApiKey(s.hasApiKey);
        setMode(s.mode);
        setRemoteUrl(s.remoteUrl);
        setHasRemoteToken(s.hasRemoteToken);
      })
      .catch((e) => onNotify(`加载设置失败: ${e?.message ?? e}`, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEdit = () => {
    setDraft({
      protocol,
      baseUrl,
      model,
      embedModel,
      apiKey: "",
      apiKeyTouched: false,
    });
    setOriginal({ protocol, baseUrl, model, embedModel });
  };

  const closeEdit = () => {
    setDraft(null);
    setOriginal(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const url = draft.baseUrl.trim();
    const name = draft.model.trim();
    if (!url) {
      onNotify("请填写 API Base URL", "error");
      return;
    }
    if (!name) {
      onNotify("请填写模型名", "error");
      return;
    }
    setSaving(true);
    try {
      const key = draft.apiKeyTouched ? draft.apiKey.trim() : null;
      const notice = await api.saveSettings(
        url,
        key,
        name,
        draft.protocol,
        draft.embedModel.trim(),
        mode,
        remoteUrl,
        null,
      );
      setProtocol(draft.protocol);
      setBaseUrl(url);
      setModel(name);
      setEmbedModel(draft.embedModel.trim());
      if (key !== null) setHasApiKey(key !== "");
      closeEdit();
      // 主进程在 embedding 模型变更时会带回向量失效警告——原样展示。
      onNotify(
        typeof notice === "string" && notice ? notice : "模型服务配置已保存",
      );
    } catch (e) {
      onNotify(`保存失败: ${e}`, "error");
    } finally {
      setSaving(false);
    }
  };

  /** Mode switch saves immediately; failure rolls the radio back (same interaction
   *  as toggleEnabled). URL/token blur-saves reuse the same call in remote mode. */
  const switchMode = async (next: "local" | "remote") => {
    const prev = mode;
    setMode(next);
    try {
      await api.saveSettings(
        baseUrl,
        null,
        model,
        protocol,
        embedModel,
        next,
        remoteUrl,
        null,
      );
      onNotify(
        next === "remote" ? "已切换到远程记忆服务" : "已切换回本地记忆服务",
      );
    } catch (e) {
      setMode(prev);
      onNotify(`保存失败: ${e}`, "error");
    }
  };

  /** Blur-save the service address (fire-and-persist, same pattern as the toggle). */
  const saveRemoteUrl = async () => {
    try {
      await api.saveSettings(
        baseUrl,
        null,
        model,
        protocol,
        embedModel,
        "remote",
        remoteUrl,
        null,
      );
    } catch (e) {
      onNotify(`保存失败: ${e}`, "error");
    }
  };

  const saveRemoteToken = async () => {
    const t = remoteToken.trim();
    // Untouched empty field = keep the stored token; typed text replaces; clearing
    // a previously-set token is an explicit clear (null = keep in the IPC contract).
    if (!t && !hasRemoteToken) return;
    try {
      await api.saveSettings(
        baseUrl,
        null,
        model,
        protocol,
        embedModel,
        "remote",
        remoteUrl,
        t ? t : null,
      );
      if (t) {
        setHasRemoteToken(true);
        setRemoteToken("");
      }
    } catch (e) {
      onNotify(`保存失败: ${e}`, "error");
    }
  };

  /** /health against the user-configured service (uses the typed token so the
   *  user can verify before saving). */
  const testConnection = async () => {
    const base = remoteUrl.trim().replace(/\/+$/, "");
    if (!base) {
      onNotify("请先填写服务地址", "error");
      return;
    }
    setTesting(true);
    try {
      const r = await api.testMemoryConnection(
        base,
        remoteToken.trim() || null,
      );
      if (!r.ok) {
        onNotify(r.error ?? "连接失败", "error");
        return;
      }
      if (!r.ready) {
        onNotify(
          r.notice ?? "服务可达，但 Embedding 未配置（语义检索不可用）",
          "error",
        );
        return;
      }
      onNotify(
        `连接成功${r.embedModel ? `：Embedding ${r.embedModel}` : ""}${
          r.notice ? `（${r.notice}）` : ""
        }`,
      );
    } catch (e) {
      onNotify(`测试失败: ${e}`, "error");
    } finally {
      setTesting(false);
    }
  };

  // Only meaningful with a draft open; a baseUrl matching no preset reads as「自定义」.
  const presetKey = draft ? presetKeyFor(draft.baseUrl) : "custom";
  const dirty =
    !!draft &&
    !!original &&
    (draft.protocol !== original.protocol ||
      draft.baseUrl.trim() !== original.baseUrl.trim() ||
      draft.model.trim() !== original.model.trim() ||
      draft.embedModel.trim() !== original.embedModel.trim() ||
      draft.apiKeyTouched);

  // 弹窗标题区分「新增」与「编辑」（对齐 joybuddy）：打开时还没有任何配置即为新增。
  const isNew = !original?.baseUrl && !original?.model;

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 mt-1 text-xs leading-5 text-muted">
        面板展示、检索、监听导入与 MCP 共享记忆均经由记忆服务完成；配置 OpenAI
        兼容服务（含
        MiniMax）后提供语义去重与语义检索，数据全部留在本地。未配置时不调用任何模型，仅支持手动添加与关键词检索。
      </p>

      {/* 记忆存储模式：本地子进程（默认，数据在 userData）或用户自部署的 server/ 远程服务。
          两种模式共用同一套 HTTP 客户端，只是地址不同；切换即时保存，失败回滚。 */}
      <section className="flex flex-col gap-3">
        <div className="text-xs font-semibold text-muted">记忆存储</div>
        <Radio.Group
          value={mode}
          onChange={(e) =>
            void switchMode(e.target.value as "local" | "remote")
          }
          optionType="button"
          buttonStyle="solid"
          options={[
            { value: "local", label: "本地服务" },
            { value: "remote", label: "远程服务" },
          ]}
          className="self-start"
        />
        {mode === "remote" && (
          <div className="flex flex-col gap-3 rounded-[10px] bg-panel px-5 py-4">
            <p className="m-0 text-xs leading-5 text-muted">
              填写自行部署的 Knot 记忆服务地址（server/ 目录提供
              Dockerfile）。远程模式下记忆与向量全部存在服务端，
              本机仅保留展示镜像；服务不可达时语义检索与导入会直接报错，不会降级写本地。
            </p>
            <FormField label="服务地址">
              <Input
                value={remoteUrl}
                placeholder="http://127.0.0.1:27184"
                onChange={(e) => setRemoteUrl(e.target.value)}
                onBlur={() => void saveRemoteUrl()}
                allowClear
              />
            </FormField>
            <FormField
              label="访问令牌"
              desc={
                hasRemoteToken
                  ? "已配置，留空保持不变"
                  : "服务未设置令牌时可留空"
              }
            >
              <Input.Password
                value={remoteToken}
                placeholder={hasRemoteToken ? "••••••••" : "可选"}
                onChange={(e) => setRemoteToken(e.target.value)}
                onBlur={() => void saveRemoteToken()}
              />
            </FormField>
            <div>
              <Button
                icon={<ApiOutlined />}
                loading={testing}
                onClick={() => void testConnection()}
              >
                测试连接
              </Button>
            </div>
          </div>
        )}
      </section>

      {mode === "local" && (
        <>
          {/* 服务配置横幅：说明 + 常驻主按钮入口。只有一套模型服务配置，已配置时按钮转为编辑同一份配置。 */}
          <section className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-muted">服务配置</div>
            <div className="flex items-center justify-between gap-4 rounded-[10px] bg-panel px-5 py-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-fg">模型服务</div>
                <div className="mt-1 text-[13px] text-muted">
                  管理记忆服务连接的模型 API，语义去重与语义检索时调用 Embedding
                  接口。
                </div>
              </div>
              <Button
                type="primary"
                icon={baseUrl || model ? <EditOutlined /> : <PlusOutlined />}
                onClick={openEdit}
                className="shrink-0"
              >
                {baseUrl || model ? "编辑配置" : "配置模型"}
              </Button>
            </div>
          </section>

          {/* 当前配置（对齐 joybuddy 的「已保存模型」区）：模型卡片，整卡可点进编辑。 */}
          <section className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-muted">当前配置</div>
            {baseUrl || model ? (
              <div
                className="cursor-pointer rounded-xl border border-line bg-surface transition-colors hover:border-accent"
                onClick={openEdit}
              >
                <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-bg">
                    <ExperimentOutlined className="text-accent" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-fg">
                        {protocol === "openai"
                          ? "OpenAI 兼容服务"
                          : "MiniMax 服务"}
                      </span>
                      {model && (
                        <Tag
                          bordered={false}
                          className="m-0 shrink-0 text-muted"
                        >
                          {model}
                        </Tag>
                      )}
                      {embedModel && (
                        <Tag
                          bordered={false}
                          className="m-0 shrink-0 text-muted"
                        >
                          {embedModel}
                        </Tag>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {hasApiKey ? "API Key 已配置" : "未配置 API Key"}
                    </div>
                  </div>
                  <Button
                    icon={<EditOutlined />}
                    className="shrink-0"
                    onClick={openEdit}
                  >
                    编辑
                  </Button>
                </div>
                <div className="flex items-center gap-1.5 border-0 border-t border-dashed border-line px-4 py-2.5 font-mono text-[11px] text-muted">
                  <LinkOutlined className="shrink-0" />
                  <span className="truncate">
                    {baseUrl || "未设置服务地址"}
                  </span>
                </div>
              </div>
            ) : (
              <Empty
                description="还没有配置模型服务"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                className="my-6"
              >
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={openEdit}
                >
                  配置模型
                </Button>
              </Empty>
            )}
          </section>
        </>
      )}

      {/* 编辑弹窗（对齐 joybuddy 的 ModelForm + 弹窗交互）：预设下拉 + 脏检测，保存成功自动关闭。 */}
      <Modal
        title={isNew ? "配置模型服务" : "编辑模型服务"}
        open={!!draft}
        onCancel={closeEdit}
        width={480}
        centered
        destroyOnHidden
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={closeEdit}>取消</Button>
            <Button
              type="primary"
              disabled={!dirty}
              loading={saving}
              onClick={() => void saveDraft()}
            >
              保存
            </Button>
          </div>
        }
      >
        {draft && (
          <div className="flex flex-col gap-4 py-2">
            <FormField label="服务预设">
              <Select
                value={presetKey}
                onChange={(key: string) => {
                  const preset = LLM_PRESETS.find((p) => p.key === key);
                  setDraft({
                    ...draft,
                    // 切到自定义时清空 Base URL 让用户手填；命中预设则自动带入，
                    // 并同步协议与该协议的 Embedding 默认模型。
                    baseUrl: preset?.baseUrl || "",
                    ...(preset?.protocol
                      ? {
                          protocol: preset.protocol,
                          embedModel: EMBED_DEFAULTS[preset.protocol],
                        }
                      : {}),
                  });
                }}
                options={LLM_PRESETS.map((p) => ({
                  value: p.key,
                  label: p.label,
                }))}
                className="w-full"
              />
            </FormField>

            <FormField
              label="接口协议"
              desc="MiniMax 用私有协议；其余 OpenAI 兼容服务选 OpenAI"
            >
              <Select
                value={draft.protocol}
                onChange={(p: "minimax" | "openai") => {
                  // 协议决定请求格式与 embedding 通道，切换时整套换到该协议的默认值。
                  setDraft({
                    ...draft,
                    protocol: p,
                    embedModel: EMBED_DEFAULTS[p],
                  });
                }}
                options={[
                  {
                    value: "minimax",
                    label: "MiniMax（私有协议，含 embo-01 转换层）",
                  },
                  { value: "openai", label: "OpenAI 兼容（标准接口直连）" },
                ]}
                className="w-full"
              />
            </FormField>

            {presetKey === "custom" && (
              <FormField label="API Base URL">
                <Input
                  value={draft.baseUrl}
                  onChange={(e) =>
                    setDraft({ ...draft, baseUrl: e.target.value })
                  }
                  placeholder={
                    draft.protocol === "minimax"
                      ? "https://api.minimax.cn/v1"
                      : "https://api.openai.com/v1"
                  }
                  allowClear
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
            )}
            <FormField label="模型名">
              <Input
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder={
                  draft.protocol === "minimax" ? "MiniMax-M2.7" : "gpt-5-mini"
                }
                allowClear
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>

            <FormField
              label="Embedding 模型"
              desc="语义检索用；更换后旧记忆向量不再匹配，建议重建记忆库"
            >
              <Input
                value={draft.embedModel}
                onChange={(e) =>
                  setDraft({ ...draft, embedModel: e.target.value })
                }
                placeholder={EMBED_DEFAULTS[draft.protocol]}
                allowClear
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>

            <FormField
              label="API Key"
              desc={hasApiKey ? "已保存，留空并保存即清除" : undefined}
            >
              <Input.Password
                value={draft.apiKey}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    apiKey: e.target.value,
                    apiKeyTouched: true,
                  })
                }
                placeholder={hasApiKey ? "••••••••" : "sk-..."}
                autoComplete="new-password"
              />
            </FormField>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** "Memory watching" pane: builtin cards have locked paths with only a toggle; custom cards are
 *  added via a top-right button that opens a small form modal. Changes persist automatically
 *  (toggle / delete / add save immediately, text edits save on blur) — the main process
 *  hot-reloads watching on every save and one-time imports existing content for newly enabled
 *  cards. */
function WatchPane({ onNotify }: { onNotify: Notify }) {
  const [rules, setRules] = useState<api.WatchRule[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draftAgent, setDraftAgent] = useState("");
  const [draftMatch, setDraftMatch] = useState("");

  useEffect(() => {
    api
      .getWatchRules()
      .then(setRules)
      .catch((e) => onNotify(`加载监听卡片失败: ${e?.message ?? e}`, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!rules) return <p className="m-0 text-xs text-muted">加载中…</p>;

  // Builtin cards render alphabetically by agent regardless of stored order;
  // custom cards keep the user's own ordering.
  const builtins = rules
    .filter((r) => r.builtin)
    .sort((a, b) => a.agent.localeCompare(b.agent));
  const customs = rules.filter((r) => !r.builtin);

  // Local-only state change (text inputs update on every keystroke; persisted on blur).
  const update = (id: string, patch: Partial<api.WatchRule>) => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // Persist immediately: hot-reloads watching in the main process (and imports existing
  // content for newly enabled cards), so it's reserved for discrete actions.
  // Rules with an empty match are sent as-is: filtering them here would silently
  // delete a card mid-edit (persist fires on blur), losing the user's input.
  const persist = async (next: api.WatchRule[]) => {
    setRules(next);
    try {
      await api.saveWatchRules(next);
    } catch (e: any) {
      onNotify(`保存失败: ${e?.message ?? e}`, "error");
    }
  };

  // Default agent name for a custom card: the first directory segment of the first entry
  // (dot stripped), e.g. .cursor/memory/*.md → cursor
  const deriveAgent = (match: string) =>
    match
      .split(",")[0]!
      .split("/")
      .find((seg) => seg && !seg.startsWith(".") && !seg.includes("*")) ?? "";

  const addCard = () => {
    const match = draftMatch.trim();
    if (!match) return;
    const agent = draftAgent.trim() || deriveAgent(match) || "custom";
    void persist([
      ...rules,
      {
        id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        agent,
        match,
        enabled: true,
      },
    ]);
    setAddOpen(false);
    setDraftAgent("");
    setDraftMatch("");
    onNotify(`已添加「${agent}」监听卡片`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="mt-1 flex items-start justify-between gap-4">
        <p className="m-0 flex-1 text-xs leading-5 text-muted">
          监听各 Agent
          的记忆文件，变更内容经提炼后自动写入记忆库；匹配表达式支持{" "}
          <code>*</code> / <code>**</code> 通配符与 <code>&lt;slug&gt;</code>{" "}
          展开。
        </p>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          className="shrink-0"
          onClick={() => setAddOpen(true)}
        >
          添加卡片
        </Button>
      </div>

      {builtins.map((r) => (
        <div key={r.id} className={cx(CARD)}>
          <AgentIcon agent={r.agent} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-fg">{r.agent}</span>
              <Tag bordered={false} className="m-0 shrink-0 text-muted">
                内置
              </Tag>
            </div>
            <div
              className="mt-0.5 truncate font-mono text-xs text-muted"
              title={r.match}
            >
              {r.match}
            </div>
          </div>
          <Switch
            checked={r.enabled}
            onChange={(enabled) =>
              void persist(
                rules.map((x) => (x.id === r.id ? { ...x, enabled } : x)),
              )
            }
          />
        </div>
      ))}

      {customs.length > 0 && (
        <>
          <div className="mt-2 text-xs font-semibold text-muted">自定义</div>
          <div className="flex flex-col gap-3">
            {customs.map((r) => (
              <div key={r.id} className={cx(CARD)}>
                <AgentIcon agent={r.agent.trim() || "custom"} size={32} />
                <Input
                  value={r.agent}
                  onChange={(e) => update(r.id, { agent: e.target.value })}
                  onBlur={() => void persist(rules)}
                  placeholder="Agent 名"
                  variant="borderless"
                  className="!px-0 font-medium"
                  style={{ width: 120 }}
                />
                <Input
                  value={r.match}
                  onChange={(e) => update(r.id, { match: e.target.value })}
                  onBlur={() => void persist(rules)}
                  placeholder=".cursor/memory/*.md"
                  variant="borderless"
                  className="min-w-0 flex-1 !px-0 font-mono text-[13px]"
                />
                <Popconfirm
                  title="删除该监听卡片？已导入的记忆会保留。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() =>
                    void persist(rules.filter((x) => x.id !== r.id))
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<CloseOutlined />}
                    aria-label={`删除 ${r.agent}`}
                  />
                </Popconfirm>
                <Switch
                  checked={r.enabled}
                  onChange={(enabled) =>
                    void persist(
                      rules.map((x) => (x.id === r.id ? { ...x, enabled } : x)),
                    )
                  }
                />
              </div>
            ))}
          </div>
        </>
      )}

      {/* Add-card form modal: agent name is optional (derived from the match path when blank). */}
      <Modal
        open={addOpen}
        title="添加监听卡片"
        okText="添加"
        cancelText="取消"
        width={480}
        okButtonProps={{ disabled: !draftMatch.trim() }}
        onOk={addCard}
        onCancel={() => setAddOpen(false)}
        destroyOnHidden
      >
        <div className="flex flex-col gap-4 py-2">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-fg">
              匹配表达式
            </div>
            <Input
              value={draftMatch}
              onChange={(e) => setDraftMatch(e.target.value)}
              onPressEnter={addCard}
              placeholder=".cursor/memory/*.md，逗号分隔多个条目"
              autoFocus
            />
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-fg">
              Agent 名
              <span className="ml-1.5 text-xs font-normal text-muted">
                留空则从路径推断
              </span>
            </div>
            <Input
              value={draftAgent}
              onChange={(e) => setDraftAgent(e.target.value)}
              onPressEnter={addCard}
              placeholder="如 cursor"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Connectors supported by the pane: one card per agent, rendered from this list.
 *  Adding an upstream is: extend inject.ts's ConnectorAgent + spec, then append here.
 *  `desc` states where the toggle writes (keep in sync with inject.ts's agentSpec);
 *  `note` carries an agent-specific extra step (workbuddy: writing the config only
 *  declares the server — it must also be trusted in workbuddy's UI). */
const CONNECTORS: {
  agent: api.ConnectorAgent;
  name: string;
  desc: string;
  note?: string;
}[] = [
  {
    agent: "claude-code",
    name: "Claude Code",
    desc: "写入 ~/.claude.json 的 mcpServers 配置，新会话生效",
  },
  {
    agent: "codex",
    name: "Codex",
    desc: "写入 ~/.codex/config.toml 的 [mcp_servers.knot] 配置段，新会话生效",
  },
  {
    agent: "hermes",
    name: "Hermes",
    desc: "写入 ~/.hermes/config.yaml 的 mcp_servers.knot 节点，新会话生效",
  },
  {
    agent: "joycode",
    name: "JoyCode",
    desc: "写入 ~/.joycode/joycode-mcp.json 的 mcpServers 配置，新会话生效",
  },
  {
    agent: "workbuddy",
    name: "WorkBuddy",
    desc: "写入 ~/.workbuddy/mcp.json 的 mcpServers 配置，需在 WorkBuddy 的「连接器管理 → 自定义连接器」中信任该服务，信任后新会话生效",
  },
];

/** "Connectors" pane: registers Knot as an MCP server in each agent's user-level config,
 *  letting agent sessions read the current project's shared memories via MCP tools
 *  (recall_memories / list_projects). One card per connection: status + toggle. */
function ConnectorsPane({ onNotify }: { onNotify: Notify }) {
  /** Per-agent binding status; undefined = still loading. */
  const [bound, setBound] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    for (const c of CONNECTORS) {
      api
        .mcpStatus(c.agent)
        .then((b) => setBound((prev) => ({ ...prev, [c.agent]: b })))
        .catch((e) =>
          onNotify(`读取连接状态失败: ${e?.message ?? e}`, "error"),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (c: (typeof CONNECTORS)[number], next: boolean) => {
    setBusy(c.agent);
    try {
      onNotify(
        next ? await api.injectMcp(c.agent) : await api.removeMcp(c.agent),
      );
      const boundNow = await api.mcpStatus(c.agent);
      setBound((prev) => ({ ...prev, [c.agent]: boundNow }));
    } catch (e: any) {
      onNotify(`操作失败: ${e?.message ?? e}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 mt-1 text-xs leading-5 text-muted">
        将 Knot 注册为各 Agent 的 MCP Server，Agent 会话内即可通过{" "}
        <code>recall_memories</code> / <code>list_projects</code>
        读取当前项目的共享记忆；开关写入各 Agent
        的用户级配置（写入前自动备份），生效方式见各卡片说明。
      </p>

      {CONNECTORS.map((c) => (
        <div key={c.agent} className={cx(CARD)}>
          <AgentIcon agent={c.agent} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-fg">{c.name}</span>
              <Tag
                bordered={false}
                className="m-0 shrink-0"
                color={bound[c.agent] ? "green" : "default"}
              >
                {bound[c.agent] ? "已绑定" : "未绑定"}
              </Tag>
            </div>
            <div className="mt-0.5 text-xs text-muted">{c.desc}</div>
          </div>
          <Switch
            checked={!!bound[c.agent]}
            loading={busy === c.agent}
            onChange={(v) => void toggle(c, v)}
          />
        </div>
      ))}
    </div>
  );
}

const GITHUB_URL = "https://github.com/marrviin/knot";
const FEEDBACK_URL = `${GITHUB_URL}/issues/new`;

/** "About" pane: app icon, name and version, a feedback button, and a footer
 *  with the repo link + copyright (aligned with manta-compare's about page). */
function AboutPane() {
  return (
    // min-h-full + mt-auto: pin the footer to the bottom of the visible panel (the panel content area is the scroll container).
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col items-center gap-3 py-14">
        <img
          src={appIcon}
          alt="Knot"
          className="h-20 w-20 rounded-xl object-contain select-none"
          draggable={false}
        />
        <div className="text-lg font-semibold text-fg">Knot</div>
        <div className="text-xs text-muted">v{pkg.version}</div>
        <Button
          icon={<MessageOutlined />}
          className="mt-2"
          onClick={() => void api.openExternal(FEEDBACK_URL)}
        >
          反馈问题
        </Button>
      </div>

      {/* Footer: repo link + copyright. */}
      <div className="mt-auto flex flex-col items-center gap-1.5 pb-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-[12px] text-muted bg-transparent border-0 cursor-pointer transition-colors hover:text-accent"
          onClick={() => void api.openExternal(GITHUB_URL)}
        >
          <GithubOutlined />
          <span>github.com/marrviin/knot</span>
        </button>
        <span className="text-[11px] text-muted select-none">
          © {new Date().getFullYear()} marrviin
        </span>
      </div>
    </div>
  );
}
