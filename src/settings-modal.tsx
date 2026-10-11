/**
 * Settings modal (antd Modal), aligned with manta-compare's latest implementation:
 * icon menu on the left + content area on the right; pane switching is managed by a
 * component-local controlled activeKey (no nested Router). Container padding is zeroed
 * → the settings shell (left menu + right content) fills the modal; the body is fixed
 * at 80vh and scrolls internally. The right side's title strip is a static in-flow bar
 * (.pc-settings-header) with the content area scrolling independently below it.
 * destroyOnHidden: each open remounts from the initial pane.
 */
import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Input, Menu, Modal, Popconfirm, Switch, Tag } from 'antd';
import {
  ApiOutlined,
  CloseOutlined,
  ExperimentOutlined,
  InfoCircleOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import cx from 'classnames';
import { menuSkinTheme } from './menu-skin';
import { AgentIcon } from './agent-icon';
import * as api from './api';

type Notify = (message: string, type?: 'info' | 'error') => void;

const TABS = [
  { key: 'general', label: '提炼层', icon: <ExperimentOutlined /> },
  { key: 'watch', label: '记忆监听', icon: <ApiOutlined /> },
  { key: 'connector', label: '连接器', icon: <LinkOutlined /> },
  { key: 'about', label: '关于', icon: <InfoCircleOutlined /> },
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
  const [pane, setPane] = useState('general');

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
      classNames={{ container: 'overflow-hidden !p-0' }}
      styles={{ body: { height: '80vh', padding: 0, overflow: 'hidden' } }}
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
              {TABS.find((t) => t.key === pane)?.label ?? '提炼层'}
            </h3>
          </div>
          <div className="box-border min-h-0 min-w-0 flex-1 overflow-auto px-6 pt-4 pb-8">
            {pane === 'about' ? (
              <AboutPane />
            ) : pane === 'watch' ? (
              <WatchPane onNotify={onNotify} />
            ) : pane === 'connector' ? (
              <ConnectorsPane onNotify={onNotify} />
            ) : (
              <GeneralPane onClose={onClose} onNotify={onNotify} />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** One-line settings row: title + description on the left, control on the right (aligned with manta-compare's row layout). */
function FieldRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-surface px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-muted">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** "Extraction" pane: LLM smart-extraction toggle + MiniMax-family service config + legacy store migration entry. */
function GeneralPane({ onClose, onNotify }: { onClose: () => void; onNotify: Notify }) {
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [legacyAvailable, setLegacyAvailable] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setEnabled(s.enabled);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
        setHasApiKey(s.hasApiKey);
      })
      .catch((e) => onNotify(`加载设置失败: ${e?.message ?? e}`, 'error'));
    api
      .legacyMigrationAvailable()
      .then(setLegacyAvailable)
      .catch(() => setLegacyAvailable(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const migrateLegacy = async () => {
    try {
      const report = await api.migrateLegacy();
      onNotify(`旧版记忆迁移完成：新增 ${report.added}，更新 ${report.updated}`);
    } catch (e: any) {
      onNotify(`迁移失败: ${e?.message ?? e}`, 'error');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(enabled, baseUrl.trim(), apiKey.trim() || null, model.trim());
      onClose();
      onNotify('提炼层设置已保存');
    } catch (e) {
      onNotify(`保存失败: ${e}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 mt-1 text-xs leading-5 text-muted">
        配置 MiniMax 系列大模型服务后，导入记忆时会用 LLM 提炼硬核事实、语义去重并裁决新旧冲突；
        记忆与向量全部只存本地，仅提炼时调用该服务。未启用时按内置规则提取。
      </p>

      <div className="flex items-center justify-between gap-4 rounded-lg bg-surface px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">启用 LLM 智能提炼</div>
          <div className="mt-0.5 text-xs text-muted">关闭后按内置规则提取记忆</div>
        </div>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>

      <FieldRow title="API Base URL">
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.minimax.cn/v1"
          style={{ width: 280 }}
        />
      </FieldRow>

      <FieldRow title="模型名">
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="MiniMax-M2.7"
          style={{ width: 280 }}
        />
      </FieldRow>

      <FieldRow title="API Key" desc={hasApiKey ? '已保存，留空不修改' : undefined}>
        <Input.Password
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasApiKey ? '••••••••' : 'sk-...'}
          style={{ width: 280 }}
        />
      </FieldRow>

      <div className="mt-3 flex items-center justify-between gap-2">
        {legacyAvailable ? (
          <Button type="text" size="small" onClick={migrateLegacy}>
            导入旧版记忆…
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Memory watching" pane: builtin cards have locked paths with only a toggle; custom cards use an
 *  "input + add" list-editor pattern (aligned with manta-compare's RuleListEditor). After saving,
 *  the main process hot-reloads watching immediately and one-time imports existing content for
 *  newly enabled cards. */
function WatchPane({ onNotify }: { onNotify: Notify }) {
  const [rules, setRules] = useState<api.WatchRule[] | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getWatchRules()
      .then(setRules)
      .catch((e) => onNotify(`加载监听卡片失败: ${e?.message ?? e}`, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!rules) return <p className="m-0 text-xs text-muted">加载中…</p>;

  const builtins = rules.filter((r) => r.builtin);
  const customs = rules.filter((r) => !r.builtin);

  const update = (id: string, patch: Partial<api.WatchRule>) => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // Default agent name for custom cards: the first directory segment of the first entry
  // (dot stripped), e.g. .cursor/memory/*.md → cursor
  const addCard = (match: string) => {
    const firstSeg =
      match
        .split(',')[0]!
        .split('/')
        .find((seg) => seg && !seg.startsWith('.') && !seg.includes('*')) ?? '';
    setRules([
      ...rules,
      {
        id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        agent: firstSeg || 'custom',
        match,
        enabled: true,
      },
    ]);
    setDraft('');
  };

  const save = async () => {
    const valid = rules.filter((r) => r.match.trim());
    setSaving(true);
    try {
      const saved = await api.saveWatchRules(valid);
      setRules(saved);
      onNotify(
        `监听卡片已保存（启用 ${saved.filter((r) => r.enabled).length} 张），正在导入新启用卡片的存量记忆`,
      );
    } catch (e: any) {
      onNotify(`保存失败: ${e?.message ?? e}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 mt-1 text-xs leading-5 text-muted">
        每个 Agent 一张卡片，打开开关即监听其记忆文件，新增或修改的记忆经提炼后自动入库。
        自定义卡片的匹配表达式用逗号分隔多个条目，支持 <code>*</code> / <code>**</code> 通配符；
        相对路径按每个已登记项目的根目录展开，<code>&lt;slug&gt;</code> 展开为项目路径 slug。
        <code>MEMORY.md</code> 索引不会入库。
      </p>

      <div className="mt-1 text-xs font-semibold text-muted">内置 Agent</div>
      {builtins.map((r) => (
        <div
          key={r.id}
          className={cx(
            'flex items-center gap-2.5 rounded-lg bg-surface px-4 py-3 transition-opacity',
            !r.enabled && 'opacity-55',
          )}
        >
          <AgentIcon agent={r.agent} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-fg">{r.agent}</span>
              <Tag bordered={false} className="m-0 shrink-0 text-muted">
                内置
              </Tag>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted" title={r.match}>
              {r.match}
            </div>
          </div>
          <Switch checked={r.enabled} onChange={(enabled) => update(r.id, { enabled })} />
        </div>
      ))}

      <div className="mt-2 text-xs font-semibold text-muted">自定义</div>
      {customs.length > 0 && (
        <div className="flex flex-col gap-2">
          {customs.map((r) => (
            <div
              key={r.id}
              className={cx(
                'flex items-center gap-2.5 rounded-lg bg-surface px-3 py-2.5 transition-opacity',
                !r.enabled && 'opacity-55',
              )}
            >
              <AgentIcon agent={r.agent.trim() || 'custom'} />
              <Input
                value={r.agent}
                onChange={(e) => update(r.id, { agent: e.target.value })}
                placeholder="Agent 名"
                variant="borderless"
                className="!px-0 font-medium"
                style={{ width: 120 }}
              />
              <Input
                value={r.match}
                onChange={(e) => update(r.id, { match: e.target.value })}
                placeholder=".cursor/memory/*.md"
                variant="borderless"
                className="min-w-0 flex-1 !px-0 font-mono text-[13px]"
              />
              <Popconfirm
                title="删除该监听卡片？已导入的记忆会保留。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => setRules(rules.filter((x) => x.id !== r.id))}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  aria-label={`删除 ${r.agent}`}
                />
              </Popconfirm>
              <Switch checked={r.enabled} onChange={(enabled) => update(r.id, { enabled })} />
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder="添加自定义监听，如 .cursor/memory/*.md"
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={() => draft.trim() && addCard(draft.trim())}
        />
        <Button type="primary" disabled={!draft.trim()} onClick={() => addCard(draft.trim())}>
          添加
        </Button>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </div>
  );
}

/** "Connectors" pane: registers Knot as an MCP server in each agent's user-level config,
 *  letting agent sessions read the current project's shared memories via MCP tools
 *  (fetch_project_knot / list_knot_projects). One row per connection: status + toggle. */
function ConnectorsPane({ onNotify }: { onNotify: Notify }) {
  const [bound, setBound] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .mcpStatus()
      .then(setBound)
      .catch((e) => onNotify(`读取连接状态失败: ${e?.message ?? e}`, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      onNotify(next ? await api.injectMcp() : await api.removeMcp());
      setBound(await api.mcpStatus());
    } catch (e: any) {
      onNotify(`操作失败: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 mt-1 text-xs leading-5 text-muted">
        连接器把 Knot 注册为 Agent 的 MCP Server，Agent 在会话里即可通过
        <code> fetch_project_knot </code> / <code>list_knot_projects</code> 工具读取当前项目
        由历史会话沉淀的共享记忆。开关写入的是用户级配置（Claude Code：
        <code>~/.claude.json</code> 顶层 <code>mcpServers</code> 键，修改前自动备份为
        <code> .knot-backup</code>），变更后需重启对应 Agent 生效。
      </p>

      <div className="flex items-center justify-between gap-4 rounded-lg bg-surface px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">Claude Code</div>
          <div className="mt-0.5 text-xs text-muted">
            {bound
              ? '已绑定：Claude Code 会话内可读取 Knot 共享记忆（重启 Claude Code 后生效）'
              : '未绑定，开启后 Knot 将注册为 Claude Code 的 MCP Server'}
          </div>
        </div>
        <Switch checked={bound} loading={busy} onChange={(v) => void toggle(v)} />
      </div>
    </div>
  );
}

/** "About" pane: app icon, name and positioning, footer copyright. */
function AboutPane() {
  return (
    // min-h-full + mt-auto: pin the footer to the bottom of the visible panel (the panel content area is the scroll container).
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col items-center gap-3 py-14">
        <span className="text-6xl leading-none select-none">🐋</span>
        <div className="text-lg font-semibold text-fg">Knot</div>
        <div className="text-xs text-muted">本地共享记忆总线</div>
      </div>

      <div className="mt-auto flex flex-col items-center gap-1.5 pb-2">
        <span className="text-[11px] text-muted select-none">
          © {new Date().getFullYear()} Knot
        </span>
      </div>
    </div>
  );
}
