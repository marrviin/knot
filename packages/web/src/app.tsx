/**
 * App shell (aligned with manta-compare's layout): a persistent left sidebar
 * (project list, antd Menu + pc-menu-skin) + a content card on the right
 * (rounded, outlined, floating on bg-panel). Global providers
 * (StyleProvider / ConfigProvider / AntdApp) wrap the outermost layer;
 * toasts go through antd message (via the AntdApp context, inheriting the theme).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  App as AntdApp,
  AutoComplete,
  ConfigProvider,
  Dropdown,
  Empty,
  Input,
  Masonry,
  Menu,
  Progress,
  Spin,
  Tag,
} from "antd";
import type { MenuProps } from "antd";
import { StyleProvider } from "@ant-design/cssinjs";
import zhCN from "antd/locale/zh_CN";
import {
  DeleteOutlined,
  EllipsisOutlined,
  FolderOutlined,
  GlobalOutlined,
  HistoryOutlined,
  LoadingOutlined,
  PlusOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import * as api from "./api";
import knotIllustration from "./assets/knot.png";
import type { Fact, ImportProgress, Project } from "./types";
import { menuSkinTheme } from "./menu-skin";
import { SettingsModal } from "./settings-modal";
import { AgentIcon } from "./agent-icon";
import { InlineMd } from "./inline-md";
import { MarqueeLabel } from "./marquee-label";

type Notify = (message: string, type?: "info" | "error") => void;

/** Import progress plus the file names ingested so far (drives the header file carousel) */
type ImportState = ImportProgress & { files: string[] };

export default function App() {
  return (
    <StyleProvider layer>
      <ConfigProvider
        locale={zhCN}
        theme={{
          cssVar: { key: "knot" },
          token: {
            // Seed colors aligned with manta-compare: accent blue + brand functional colors.
            colorPrimary: "#3768fa",
            colorInfo: "#3768fa",
            colorSuccess: "#00b26f",
            colorWarning: "#f08433",
            colorError: "#f33b50",
            // Softer borders, rounder surfaces, light desktop/container backgrounds.
            colorBorder: "#e8e8ea",
            borderRadius: 12,
            borderRadiusSM: 8,
            borderRadiusXS: 6,
            colorBgLayout: "#f2f2f2",
            colorBgContainer: "#fafafa",
            controlItemBgActive: "rgba(0,0,0,0.06)",
          },
          components: {
            // Flat buttons — remove antd's default primary/default/danger button shadows.
            Button: {
              primaryShadow: "none",
              defaultShadow: "none",
              dangerShadow: "none",
            },
          },
        }}
      >
        <AntdApp message={{ top: 72 }}>
          <Shell />
        </AntdApp>
      </ConfigProvider>
    </StyleProvider>
  );
}

function Shell() {
  const { message } = AntdApp.useApp();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Ongoing existing-content imports, keyed by project path (drives the header
  // progress ring + file carousel in FactPanel)
  const [imports, setImports] = useState<Record<string, ImportState>>({});
  // Last project path a facts load completed for — `!== activePath` means loading
  // (a plain boolean would flicker on the per-file facts-changed storm during import)
  const [factsLoadedPath, setFactsLoadedPath] = useState<string | null>(null);
  // Startup restore: read "last opened project" once after the project list first loads
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [restored, setRestored] = useState(false);

  const notify = useCallback<Notify>(
    (msg, type = "info") => {
      if (!msg) return;
      if (type === "error") message.error(msg);
      else message.info(msg);
    },
    [message],
  );

  const reloadProjects = useCallback(() => {
    api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        setProjectsLoaded(true);
      })
      .catch((e) => notify(`加载项目失败: ${e}`, "error"));
  }, [notify]);

  // Request sequence guard: during an import storm (facts-changed per file) the user
  // can switch projects — a late response for the old project must not overwrite the
  // new project's facts (stale data shown under the wrong panel header).
  const factsReqRef = useRef(0);
  const reloadFacts = useCallback((path: string) => {
    const seq = ++factsReqRef.current;
    api
      .listFacts(path)
      .then((f) => {
        if (seq !== factsReqRef.current) return;
        setFacts(f);
        setFactsLoadedPath(path);
      })
      .catch(() => {
        if (seq === factsReqRef.current) setFacts([]);
      });
  }, []);

  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  // Restore last opened project at startup: wait for the project list to load before
  // reading the stored value, to avoid restoring a removed project. Don't write until
  // restore completes, so the stored value isn't wiped.
  useEffect(() => {
    if (!projectsLoaded || restored) return;
    api
      .getLastProject()
      .then((last) => {
        if (last && projects.some((p) => p.path === last)) setActivePath(last);
      })
      .catch(() => {})
      .finally(() => setRestored(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, restored]);

  // Afterwards, record every project switch (or selection clear) for the next launch
  useEffect(() => {
    if (!restored) return;
    void api.setLastProject(activePath ?? "");
  }, [restored, activePath]);

  useEffect(() => {
    if (activePath) reloadFacts(activePath);
    else setFacts([]);
  }, [activePath, reloadFacts]);

  // Refresh after the background watcher ingests new memories / manual edits
  useEffect(() => {
    return window.knot.listen(
      "knot://facts-changed",
      (e: { path: string; notice?: string | null; refreshAll?: boolean }) => {
        if (e.path === activePath || e.refreshAll)
          reloadFacts(e.path ? e.path : (activePath ?? ""));
        reloadProjects();
        if (e.notice) notify(e.notice);
      },
    );
  }, [notify, reloadFacts, reloadProjects, activePath]);

  // Import progress: header ring + file carousel in the importing project's panel
  // + summary toasts. State lives in Shell — FactPanel remounts on project switch
  // (key={active.path}), so the accumulated file list survives the remount.
  useEffect(() => {
    return window.knot.listen("knot://import-progress", (p: ImportProgress) => {
      if (p.phase === "start") {
        setImports((m) => ({ ...m, [p.project]: { ...p, files: [] } }));
      } else if (p.phase === "file") {
        // Ignore late events whose start was never seen (missed event / cleared state)
        setImports((m) => {
          const cur = m[p.project];
          if (!cur) return m;
          return {
            ...m,
            [p.project]: {
              ...cur,
              ...p,
              // The same file can be matched by several cards — show it once
              files:
                p.file && !cur.files.includes(p.file)
                  ? [...cur.files, p.file]
                  : cur.files,
            },
          };
        });
      } else {
        setImports((m) => {
          if (!(p.project in m)) return m;
          const { [p.project]: _drop, ...rest } = m;
          return rest;
        });
        if (p.notice) {
          notify(p.notice, "error");
        } else if (
          p.report &&
          p.report.added + p.report.updated + p.report.deleted > 0
        ) {
          notify(
            `存量导入完成：新增 ${p.report.added}，更新 ${p.report.updated}` +
              (p.report.deleted ? `，删除 ${p.report.deleted}` : ""),
          );
        }
      }
    });
  }, [notify]);

  const addProjectByPath = useCallback(
    async (path: string) => {
      try {
        const project = await api.addProject(path);
        reloadProjects();
        setActivePath(project.path);
      } catch (e) {
        notify(`添加项目失败: ${e}`, "error");
      }
    },
    [notify, reloadProjects],
  );

  // Dropping a directory onto the window takes it over (HTML5 drag; path resolved via preload's webUtils)
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const path = window.knot.getPathForFile(file);
      if (path) addProjectByPath(path);
    },
    [addProjectByPath],
  );

  const pickDirectory = async () => {
    const selected = await api.pickDirectory();
    if (selected) await addProjectByPath(selected);
  };

  const removeProject = async (project: Project) => {
    try {
      await api.removeProject(project.path);
      if (activePath === project.path) setActivePath(null);
      reloadProjects();
      notify(`已移除项目「${project.name}」`);
    } catch (e) {
      notify(`移除失败: ${e}`, "error");
    }
  };

  const active = projects.find((p) => p.path === activePath) ?? null;

  // Project list item: icon on the left + name (marquee shows the full name on hover when
  // overflowing), fact count on the right edge (.pc-menu-meta) and a remove menu
  // (.pc-menu-more, three-dot button fading in on hover; the portal popup's clicks
  // never bubble up here).
  const projectItems: MenuProps["items"] = projects.map((p) => ({
    key: p.path,
    icon:
      p.path === api.GLOBAL_PROJECT ? <GlobalOutlined /> : <FolderOutlined />,
    label: (
      <span className="flex w-full min-w-0 items-center">
        <MarqueeLabel className="w-auto flex-[1_1_auto]" text={p.name} />
        <span className="pc-menu-meta">{p.factCount}</span>
        {p.path !== api.GLOBAL_PROJECT && (
          <Dropdown
            trigger={["click"]}
            placement="bottomRight"
            menu={{
              items: [
                {
                  key: "remove",
                  danger: true,
                  icon: <DeleteOutlined />,
                  label: "移除项目",
                },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "remove") void removeProject(p);
              },
            }}
          >
            <EllipsisOutlined
              className="pc-menu-more"
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        )}
      </span>
    ),
  }));

  return (
    <div
      className="flex h-screen overflow-hidden bg-panel"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Sidebar (persistent): fixed-width outer shell prevents shrinking; inner column scrolls;
          bottom pb-4 matches manta-compare's aside */}
      <aside className="h-full w-60 flex-none overflow-hidden">
        <div className="flex h-full w-60 flex-col overflow-y-auto pb-4">
          {/* Top drag strip: left blank for macOS traffic lights (hiddenInset, light zone y 18–30),
              matching manta-compare's 48px blank drag strip; used only for window dragging. */}
          <div className="h-14 shrink-0 [-webkit-app-region:drag]" />

          {/* Brand area: below the light zone, not sharing its band; click returns home (clears the selected project) */}
          <div
            className="flex shrink-0 cursor-pointer items-center gap-2 px-4 pb-3"
            onClick={() => setActivePath(null)}
            title="回到首页"
          >
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[16px] leading-tight font-semibold text-fg">
                  结绳
                </span>
                <span className="text-[12px] leading-tight text-muted">
                  jié shéng
                </span>
              </div>
              <div className="truncate mt-1 text-[12px] leading-tight text-muted">
                事大大其绳 · 事小小其绳
              </div>
            </div>
          </div>

          {/* Action area: add project. Menu's onClick also fires on an already-selected item, so no selectable needed. */}
          <div className="shrink-0">
            <ConfigProvider theme={menuSkinTheme}>
              <Menu
                mode="inline"
                selectable={false}
                className="pc-menu-skin px-2 pt-2 pb-3"
                items={[
                  { key: "add", icon: <PlusOutlined />, label: "添加项目" },
                ]}
                onClick={() => void pickDirectory()}
              />
            </ConfigProvider>
          </div>

          {/* Divider between the action area and the project list */}
          <div className="mx-2 my-1 h-px shrink-0 bg-split" />
          <div className="shrink-0 px-4 pt-1 pb-1 text-[12px] text-muted">
            项目
          </div>

          {projects.length === 0 ? (
            <div className="shrink-0 pt-6">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null} />
            </div>
          ) : (
            <ConfigProvider theme={menuSkinTheme}>
              <Menu
                mode="inline"
                className="pc-menu-skin min-h-0 flex-1 overflow-auto px-2 pb-2 pt-0"
                selectedKeys={activePath ? [activePath] : []}
                items={projectItems}
                onClick={({ key }) => setActivePath(key)}
              />
            </ConfigProvider>
          )}

          {/* Bottom pinned area (mt-auto always sticks to the bottom): settings entry
              (the MCP connection toggle lives in Settings → Connectors) */}
          <div className="mt-auto shrink-0 px-2 py-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-sm text-fg transition-colors hover:bg-hover"
            >
              <SettingOutlined />
              <span className="flex-1 text-left">设置</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Content card: rounded, outlined container floating on bg-panel (aligned with manta-compare's content card) */}
      <div className="relative m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-white/10 bg-surface outline outline-(--color-line)">
        {active ? (
          <FactPanel
            key={active.path}
            project={active}
            facts={facts}
            importing={imports[active.path] ?? null}
            loading={factsLoadedPath !== active.path}
            onNotify={notify}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            {/* Home empty state: knot-tying illustration (a rope hung with memory knots);
                the white-background image blends right into the light surface */}
            <img
              src={knotIllustration}
              alt="结绳记事"
              className="w-[min(360px,80%)] select-none"
              draggable={false}
            />
            <div className="text-[14px] text-muted">事大大其绳，事小小其绳</div>
          </div>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onNotify={notify}
      />
    </div>
  );
}

function FactPanel({
  project,
  facts,
  importing,
  loading,
  onNotify,
}: {
  project: Project;
  facts: Fact[];
  /** Ongoing existing-content import for this project (null = none) */
  importing: Pick<ImportState, "current" | "total" | "files"> | null;
  /** Facts for this project not loaded yet (avoids flashing Empty on switch) */
  loading: boolean;
  onNotify: Notify;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<api.SemanticHit[] | null>(null);
  /** This project's recent searches (last 10, newest first) for the dropdown */
  const [history, setHistory] = useState<string[]>([]);
  const [watchAgents, setWatchAgents] = useState<string[]>([]);
  /** Header icon filter: show only this agent's memories (null = all) */
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  useEffect(() => {
    api
      .getWatchRules()
      .then((rules) =>
        setWatchAgents(rules.filter((r) => r.enabled).map((r) => r.agent)),
      )
      .catch(() => setWatchAgents([]));
  }, []);

  useEffect(() => {
    api
      .getSearchHistory(project.path)
      .then(setHistory)
      .catch(() => {});
  }, [project.path]);

  // Agents that actually have memories in this project (drives the header icons;
  // derived from the loaded facts so it tracks imports/deletions automatically)
  const factAgents = useMemo(
    () => [...new Set(facts.map((f) => f.agent).filter(Boolean))] as string[],
    [facts],
  );
  const shownFacts = useMemo(
    () => (agentFilter ? facts.filter((f) => f.agent === agentFilter) : facts),
    [facts, agentFilter],
  );
  const shownHits = useMemo(
    () =>
      agentFilter && hits ? hits.filter((h) => h.agent === agentFilter) : hits,
    [hits, agentFilter],
  );

  // Debounce input by 500ms and auto-search; restore results when cleared
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.searchMemories(project.path, q);
        if (!cancelled) {
          setHits(result);
          // Record the executed search (per project, dedupe + keep the last 10);
          // failures don't pollute the history
          api
            .pushSearchHistory(project.path, q)
            .then(setHistory)
            .catch(() => {});
        }
      } catch (e: any) {
        if (!cancelled) onNotify(`检索失败: ${e?.message ?? e}`, "error");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, project.path, onNotify]);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h2 className="m-0 text-lg font-semibold text-fg">
              {project.name}
            </h2>
            <Tag className="m-0">
              {agentFilter
                ? `${shownFacts.length}/${facts.length}`
                : facts.length}{" "}
              条记忆
            </Tag>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {importing ? (
              /* Import in progress: ring progress + the current file as plain
                  text, replacing the search box while it runs */
              <div className="flex h-8 items-center gap-2">
                <Progress
                  type="circle"
                  percent={
                    importing.total > 0
                      ? Math.round((importing.current / importing.total) * 100)
                      : 0
                  }
                  size={16}
                  strokeWidth={8}
                  format={() => ""}
                />
                {/* Plain text: current file only (no roll) — adaptive width up
                    to 224px keeps the gap to the ring fixed; truncate clamps
                    very long names */}
                <div
                  className="flex max-w-56 items-center gap-1.5 text-xs text-muted"
                  aria-live="polite"
                >
                  <span className="shrink-0 font-mono tabular-nums">
                    {importing.files.length > 0
                      ? `${importing.files.length}/${importing.total}`
                      : `0/${importing.total}`}
                  </span>
                  <span className="truncate font-mono">
                    {importing.files.length > 0
                      ? importing.files[importing.files.length - 1]
                          .split("/")
                          .pop()
                      : `共 ${importing.total} 个文件，等待导入…`}
                  </span>
                </div>
              </div>
            ) : (
              /* mem0 semantic search: debounced input triggers automatically;
                  the dropdown lists this project's last 10 searches (unfiltered,
                  like a browser search box) — picking one re-runs it */
              <AutoComplete
                value={query}
                onChange={setQuery}
                className="w-72"
                options={history.map((h) => ({
                  value: h,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <HistoryOutlined className="text-muted" />
                      <span className="truncate">{h}</span>
                    </span>
                  ),
                }))}
                filterOption={false}
                defaultActiveFirstOption={false}
              >
                <Input
                  placeholder="输入关键词搜索"
                  allowClear
                  suffix={searching ? <LoadingOutlined spin /> : undefined}
                />
              </AutoComplete>
            )}
            {/* One icon per agent that has memories here; click filters the list, click again clears */}
            {factAgents.length > 0 && (
              <div className="flex items-center gap-1.5">
                {factAgents.map((agent) => {
                  const active = agentFilter === agent;
                  return (
                    <button
                      key={agent}
                      type="button"
                      title={`${AGENT_LABELS[agent] ?? agent}（点击过滤，再次点击取消）`}
                      onClick={() =>
                        setAgentFilter((cur) => (cur === agent ? null : agent))
                      }
                      className={`flex cursor-pointer items-center rounded-lg border-0 p-1 transition-colors ${
                        active
                          ? "bg-[color-mix(in_srgb,#3768fa_12%,transparent)]"
                          : "bg-transparent opacity-60 hover:opacity-100"
                      }`}
                    >
                      <AgentIcon agent={agent} size={22} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {watchAgents.length === 0 && (
          <p className="mt-1 mb-0 truncate text-xs text-muted">
            （未配置监听卡片，见 设置 → 记忆监听）
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {hits ? (
          <>
            <p className="mb-3 text-xs text-muted">
              {shownHits?.some((h) => h.semanticScore != null)
                ? `混合检索「${query}」命中 ${shownHits.length} 条（关键词 + 语义，RRF 融合排序）`
                : `关键词检索「${query}」命中 ${shownHits?.length ?? 0} 条（语义路径无足够相关的命中，如英文词查中文记忆）`}
            </p>
            {(shownHits?.length ?? 0) === 0 && (
              <div className="mt-16">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="没有语义相关的记忆。"
                />
              </div>
            )}
            <Masonry
              columns={{ xs: 2, sm: 2, md: 2, lg: 2, xl: 3, xxl: 4 }}
              gutter={[16, 16]}
              // On mount, fonts/styles aren't stable yet: the first height measurement runs large
              // and is never re-measured, inflating the container height and making the scrollbar
              // far longer than the content (large blank space at the bottom). `fresh` enables a
              // per-item ResizeObserver that re-measures and corrects after height changes.
              fresh
              items={shownHits?.map((h) => ({
                key: h.id,
                data: h,
                children: (
                  <div className="rounded-xl border border-line bg-surface p-4">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      {h.semanticScore != null ? (
                        <Tag
                          bordered={false}
                          color={h.semanticScore > 0.6 ? "green" : "default"}
                          className="m-0"
                        >
                          相关度 {Math.round(h.semanticScore * 100)}%
                        </Tag>
                      ) : (
                        <Tag bordered={false} className="m-0">
                          关键词匹配
                        </Tag>
                      )}
                    </div>
                    <p className="m-0 text-sm leading-6 whitespace-pre-wrap wrap-anywhere">
                      <InlineMd text={h.memory} />
                    </p>
                    <FactMeta
                      agent={h.agent}
                      type={h.type}
                      source={h.source}
                      time={h.updatedAt ? formatTime(h.updatedAt) : undefined}
                    />
                  </div>
                ),
              }))}
            />
          </>
        ) : (
          <>
            <Masonry
              columns={{ xs: 2, sm: 2, md: 2, lg: 2, xl: 3, xxl: 4 }}
              gutter={[16, 16]}
              fresh
              items={shownFacts.map((fact) => ({
                key: fact.id,
                data: fact,
                children: <FactCard fact={fact} />,
              }))}
            />
            {facts.length === 0 && loading && (
              <div className="flex h-full items-center justify-center">
                <Spin />
              </div>
            )}
            {shownFacts.length === 0 && !loading && (
              <div className="flex h-full flex-col items-center justify-center gap-2">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={false}
                />
                {importing && (
                  <span className="text-xs text-muted">存量记忆导入中…</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  joycode: "JoyCode",
  codex: "Codex",
  hermes: "Hermes",
  myagent: "自研 Agent",
  user: "人工",
};

const TYPE_LABELS: Record<string, string> = {
  "local-memory": "本地记忆",
  manual: "人工录入",
};

function shortenPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Path display with a centered ellipsis: both the head (directory prefix) and tail (filename) are kept.
 *  Recomputes the number of characters that fit when the container width changes (monospace font,
 *  char width measured via canvas). The path renders in font-mono with constant char width, so a
 *  proportional cut is enough — no binary search needed. */
function MiddlePath({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const style = getComputedStyle(el);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const charWidth = ctx.measureText("0".repeat(100)).width / 100;
    const ellipsisWidth = ctx.measureText("…").width;

    const fit = () => {
      const max = el.clientWidth;
      if (max <= 0 || charWidth <= 0 || text.length * charWidth <= max) {
        setDisplay(text);
        return;
      }
      const visible = Math.max(
        1,
        Math.floor((max - ellipsisWidth) / charWidth),
      );
      const head = Math.max(1, Math.round(visible * 0.6));
      const tail = Math.max(1, visible - head);
      setDisplay(`${text.slice(0, head)}…${text.slice(text.length - tail)}`);
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <span ref={ref} className="block whitespace-nowrap">
      {display}
    </span>
  );
}

/** Card metadata timestamp: MM/DD HH:mm — fits even on narrow masonry cards */
function formatTime(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Card footer metadata (shared by FactCard and search results).
 *  On narrow masonry cards the original single line of "tags + path + time" doesn't fit,
 *  so it's two lines: line 1 is agent · type (plain text, ellipsized) + time (right-aligned);
 *  line 2 gives the source path a full row, monospace with an ellipsis, full path on hover. */
function FactMeta({
  agent,
  type,
  source,
  time,
}: {
  agent?: string;
  type?: string;
  source?: string;
  time?: string;
}) {
  const parts = [
    agent ? (AGENT_LABELS[agent] ?? agent) : null,
    type ? (TYPE_LABELS[type] ?? type) : null,
  ].filter(Boolean);
  const { message } = AntdApp.useApp();
  return (
    <div className="mt-3 min-w-0 text-[11px] text-muted">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate">{parts.join(" · ")}</span>
        {time && <span className="shrink-0 whitespace-nowrap">{time}</span>}
      </div>
      {source && (
        <div
          className="mt-1 cursor-pointer font-mono text-[10px] transition-colors hover:text-fg"
          title={`${shortenPath(source)}（点击打开文件）`}
          onClick={() => {
            api.openPath(source).catch((e) => {
              message.error(`打开文件失败: ${e?.message ?? e}`);
            });
          }}
        >
          <MiddlePath text={shortenPath(source)} />
        </div>
      )}
    </div>
  );
}

function FactCard({ fact }: { fact: Fact }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="m-0 text-sm leading-6 whitespace-pre-wrap wrap-anywhere">
        <InlineMd text={fact.content} />
      </p>
      <FactMeta
        agent={fact.agent}
        type={fact.type}
        source={fact.source}
        time={formatTime(fact.updatedAt)}
      />
    </div>
  );
}
