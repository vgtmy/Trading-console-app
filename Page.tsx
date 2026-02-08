import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * 个人交易系统模板 App（完整版交易操作台）
 * - 双模型（趋势 / 反弹）打分
 * - 风控：自动仓位计算（按最大风险）
 * - 交易日志：增删改查、标签、过滤
 * - 统计：胜率、盈亏比、Profit Factor、R 值、曲线
 * - 导入/导出：JSON
 *
 * 说明：本地 localStorage 存储，适合自用。后续可替换为后端/数据库。
 */

// ---------- Types (JS Doc for editor hints) ----------
/** @typedef {"trend"|"rebound"} ModelType */
/** @typedef {"open"|"closed"} TradeStatus */

/** @typedef {{
 *  id: string;
 *  createdAt: number;
 *  updatedAt: number;
 *  symbol: string;
 *  name: string;
 *  industry: string;
 *  model: ModelType;
 *  timeframe: "swing"|"mid";
 *  priceNow: number;
 *  entry: number;
 *  stop: number;
 *  target: number;
 *  positionPct: number; // % of equity
 *  sizeShares: number; // shares/units
 *  score: number;
 *  checklist: Record<string, boolean>;
 *  status: TradeStatus;
 *  exit: number;
 *  pnl: number; // currency
 *  rMultiple: number; // R
 *  tags: string[];
 *  notes: string;
 * }} Trade */

// ---------- Storage helpers ----------
const LS_KEY = "trading_ops_console_v1";

function safeParseJSON(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return Number(n).toFixed(d);
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------- Model definitions ----------
const TREND_ITEMS = [
  { key: "maBull", label: "均线多头（5>10>20）", weight: 20 },
  { key: "aboveMA20", label: "股价站上MA20", weight: 15 },
  { key: "weeklyUp", label: "周线趋势向上", weight: 15 },
  { key: "breakout", label: "平台/箱体突破", weight: 15 },
  { key: "breakoutVol", label: "突破放量", weight: 15 },
  { key: "pullbackVol", label: "回调缩量", weight: 10 },
  { key: "momentumOk", label: "动能健康（MACD/RSI）", weight: 10 },
];

const REBOUND_ITEMS = [
  { key: "drawdown30", label: "跌幅>30%", weight: 20 },
  { key: "support", label: "接近历史支撑区", weight: 20 },
  { key: "valueOk", label: "估值安全（PE/PB合理）", weight: 10 },
  { key: "stopK", label: "止跌K线（长下影/反包）", weight: 20 },
  { key: "firstVolUp", label: "首次放量阳线/反转量", weight: 15 },
  { key: "macdTurn", label: "MACD低位金叉/底背离", weight: 15 },
];

function scoreChecklist(model, checklist) {
  const items = model === "trend" ? TREND_ITEMS : REBOUND_ITEMS;
  const total = items.reduce((s, it) => s + it.weight, 0);
  const got = items.reduce((s, it) => s + (checklist[it.key] ? it.weight : 0), 0);
  const pct = total === 0 ? 0 : Math.round((got / total) * 100);
  return clamp(pct, 0, 100);
}

function verdict(model, score) {
  if (model === "trend") {
    if (score >= 80) return { text: "✅ 可建仓", tone: "good" };
    if (score >= 70) return { text: "⚠️ 轻仓试错", tone: "warn" };
    return { text: "❌ 放弃", tone: "bad" };
  }
  // rebound
  if (score >= 75) return { text: "✅ 可试仓（反弹）", tone: "good" };
  if (score >= 65) return { text: "⚠️ 观察（等信号）", tone: "warn" };
  return { text: "❌ 放弃", tone: "bad" };
}

// ---------- Risk & sizing ----------
function calcRiskPosition({ equity, maxRiskPct, entry, stop, priceNow, lotSize }) {
  const e = Number(equity);
  const r = Number(maxRiskPct) / 100;
  const en = Number(entry || priceNow);
  const st = Number(stop);
  const ls = Number(lotSize || 1);

  if (!e || !r || !en || !st || en <= 0 || st <= 0) {
    return { riskPerShare: 0, riskMoney: 0, shares: 0, positionMoney: 0, positionPct: 0 };
  }

  const riskPerShare = Math.abs(en - st);
  if (riskPerShare === 0) {
    return { riskPerShare: 0, riskMoney: 0, shares: 0, positionMoney: 0, positionPct: 0 };
  }

  const riskMoney = e * r;
  let shares = Math.floor((riskMoney / riskPerShare) / ls) * ls;
  shares = Math.max(0, shares);

  const positionMoney = shares * en;
  const positionPct = e > 0 ? (positionMoney / e) * 100 : 0;

  return {
    riskPerShare,
    riskMoney,
    shares,
    positionMoney,
    positionPct,
  };
}

function calcRMultiple(trade) {
  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const exit = Number(trade.exit);
  const size = Number(trade.sizeShares);

  if (!entry || !stop || !exit || !size) return 0;
  const riskPerShare = Math.abs(entry - stop);
  if (riskPerShare === 0) return 0;

  const pnlPerShare = exit - entry;
  // long-only assumption for now; can extend later.
  const r = pnlPerShare / riskPerShare;
  return r;
}

function calcPnL(trade) {
  const entry = Number(trade.entry);
  const exit = Number(trade.exit);
  const size = Number(trade.sizeShares);
  if (!entry || !exit || !size) return 0;
  return (exit - entry) * size;
}

// ---------- UI helpers ----------
function TonePill({ v }) {
  const cls =
    v.tone === "good"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : v.tone === "warn"
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-rose-50 text-rose-700 border-rose-200";
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full border text-sm ${cls}`}>
      {v.text}
    </span>
  );
}

function SectionTitle({ title, subtitle }) {
  return (
    <div className="grid gap-1">
      <div className="text-lg font-semibold">{title}</div>
      {subtitle ? <div className="text-sm text-muted-foreground">{subtitle}</div> : null}
    </div>
  );
}

function useLocalStorageState(key, initialValue) {
  const [state, setState] = useState(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    return raw ? safeParseJSON(raw, initialValue) : initialValue;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [key, state]);

  return [state, setState];
}

// ---------- Main App ----------
export default function TradingOpsConsoleApp() {
  const [store, setStore] = useLocalStorageState(LS_KEY, {
    settings: {
      equity: 100000,
      maxRiskPct: 1.0,
      lotSize: 100,
      defaultTimeframe: "mid",
      defaultModel: "trend",
      currency: "CNY",
    },
    trades: /** @type {Trade[]} */ ([]),
  });

  const settings = store.settings;
  const trades = store.trades;

  const [activeTab, setActiveTab] = useState("dashboard");

  // Filters
  const [filter, setFilter] = useState({
    q: "",
    model: "all",
    status: "all",
    tag: "",
  });

  // New trade state
  const [draft, setDraft] = useState(() => makeBlankTrade(settings));

  // Edit modal
  const [editing, setEditing] = useState(/** @type {Trade|null} */ (null));

  // Import/export
  const fileInputRef = useRef(null);

  // Derived scoring & sizing for draft
  const draftScore = useMemo(() => scoreChecklist(draft.model, draft.checklist), [draft.model, draft.checklist]);
  const draftVerdict = useMemo(() => verdict(draft.model, draftScore), [draft.model, draftScore]);

  const sizing = useMemo(() =>
    calcRiskPosition({
      equity: settings.equity,
      maxRiskPct: settings.maxRiskPct,
      entry: draft.entry,
      stop: draft.stop,
      priceNow: draft.priceNow,
      lotSize: settings.lotSize,
    }),
  [settings.equity, settings.maxRiskPct, settings.lotSize, draft.entry, draft.stop, draft.priceNow]);

  // Keep draft score synced
  useEffect(() => {
    setDraft((d) => ({ ...d, score: draftScore }));
  }, [draftScore]);

  // If stop/entry changes, update suggested size/position but do not override user's manual values if already set.
  useEffect(() => {
    setDraft((d) => {
      const autoShares = sizing.shares;
      const autoPct = sizing.positionPct;
      // If user hasn't typed shares/position yet, keep them auto.
      const shouldAutoShares = !d._manualShares;
      const shouldAutoPct = !d._manualPct;
      return {
        ...d,
        sizeShares: shouldAutoShares ? autoShares : d.sizeShares,
        positionPct: shouldAutoPct ? autoPct : d.positionPct,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizing.shares, sizing.positionPct]);

  const filteredTrades = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return trades
      .filter((t) => {
        if (filter.model !== "all" && t.model !== filter.model) return false;
        if (filter.status !== "all" && t.status !== filter.status) return false;
        if (filter.tag.trim()) {
          const tg = filter.tag.trim().toLowerCase();
          if (!(t.tags || []).some((x) => x.toLowerCase().includes(tg))) return false;
        }
        if (!q) return true;
        const hay = [t.symbol, t.name, t.industry, (t.tags || []).join(","), t.notes]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [trades, filter]);

  const kpis = useMemo(() => computeKPIs(trades, settings.equity), [trades, settings.equity]);

  function updateSettings(patch) {
    setStore((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  }

  function resetDraft() {
    setDraft(makeBlankTrade(store.settings));
  }

  function addTrade() {
    // guard: stop loss required
    if (!draft.symbol.trim()) return alert("请先填写股票代码/标的。");
    if (!draft.stop || Number(draft.stop) <= 0) return alert("止损价必填（无止损不允许下单）。");

    const t = normalizeTrade({ ...draft });
    const now = Date.now();
    const trade = {
      ...t,
      id: uid(),
      createdAt: now,
      updatedAt: now,
      status: "open",
      exit: 0,
      pnl: 0,
      rMultiple: 0,
    };

    setStore((s) => ({ ...s, trades: [trade, ...s.trades] }));
    resetDraft();
    setActiveTab("trades");
  }

  function deleteTrade(id) {
    if (!confirm("确定删除这笔交易吗？")) return;
    setStore((s) => ({ ...s, trades: s.trades.filter((t) => t.id !== id) }));
  }

  function closeTrade(id, exitPrice) {
    const ep = Number(exitPrice);
    if (!ep || ep <= 0) return alert("请输入有效的平仓价。");

    setStore((s) => {
      const trades2 = s.trades.map((t) => {
        if (t.id !== id) return t;
        const updated = {
          ...t,
          status: "closed",
          exit: ep,
        };
        const pnl = calcPnL(updated);
        const r = calcRMultiple(updated);
        return { ...updated, pnl, rMultiple: r, updatedAt: Date.now() };
      });
      return { ...s, trades: trades2 };
    });
  }

  function updateTrade(id, patch) {
    setStore((s) => {
      const trades2 = s.trades.map((t) => {
        if (t.id !== id) return t;
        const merged = normalizeTrade({ ...t, ...patch, updatedAt: Date.now() });
        // if already closed, keep pnl/r in sync
        if (merged.status === "closed" && merged.exit) {
          const pnl = calcPnL(merged);
          const r = calcRMultiple(merged);
          return { ...merged, pnl, rMultiple: r };
        }
        return merged;
      });
      return { ...s, trades: trades2 };
    });
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trading_ops_console_export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"));
        if (!data || typeof data !== "object") throw new Error("bad");
        if (!data.settings || !Array.isArray(data.trades)) throw new Error("format");
        // Light normalization
        const trades2 = data.trades.map((t) => normalizeTrade(t)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setStore({
          settings: { ...store.settings, ...data.settings },
          trades: trades2,
        });
        alert("导入成功。\n建议你检查一下设置与交易记录是否正确。");
      } catch {
        alert("导入失败：文件格式不正确。");
      }
    };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!confirm("这会清空所有数据（本地）。确定继续？")) return;
    setStore({
      settings: {
        equity: 100000,
        maxRiskPct: 1.0,
        lotSize: 100,
        defaultTimeframe: "mid",
        defaultModel: "trend",
        currency: "CNY",
      },
      trades: [],
    });
    resetDraft();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto grid gap-6">
      <Header settings={settings} kpis={kpis} onExport={exportJSON} onImportClick={() => fileInputRef.current?.click()} />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importJSON(f);
          e.target.value = "";
        }}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="dashboard">仪表盘</TabsTrigger>
          <TabsTrigger value="new">新建计划</TabsTrigger>
          <TabsTrigger value="trades">交易日志</TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-6">
          <Dashboard kpis={kpis} trades={trades} currency={settings.currency} />
        </TabsContent>

        <TabsContent value="new" className="mt-6">
          <NewTrade
            settings={settings}
            draft={draft}
            setDraft={setDraft}
            sizing={sizing}
            score={draftScore}
            verdict={draftVerdict}
            onSave={addTrade}
            onReset={resetDraft}
          />
        </TabsContent>

        <TabsContent value="trades" className="mt-6">
          <Trades
            trades={filteredTrades}
            currency={settings.currency}
            filter={filter}
            setFilter={setFilter}
            onDelete={deleteTrade}
            onClose={closeTrade}
            onEdit={(t) => setEditing(t)}
          />
        </TabsContent>

        <TabsContent value="settings" className="mt-6">
          <Settings
            settings={settings}
            onUpdate={updateSettings}
            onClearAll={clearAll}
          />
        </TabsContent>
      </Tabs>

      <AnimatePresence>
        {editing ? (
          <EditDialog
            key="edit"
            trade={editing}
            currency={settings.currency}
            lotSize={settings.lotSize}
            onClose={() => setEditing(null)}
            onSave={(patch) => {
              updateTrade(editing.id, patch);
              setEditing(null);
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ---------- Components ----------

function Header({ settings, kpis, onExport, onImportClick }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <div className="text-2xl font-bold">个人交易操作台</div>
          <div className="text-sm text-muted-foreground">
            双模型 · 风控仓位 · 交易日志 · 统计复盘（本地保存）
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onImportClick}>
            导入
          </Button>
          <Button variant="secondary" onClick={onExport}>
            导出
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard title="账户权益" value={`${fmt(settings.equity, 0)} ${settings.currency}`} subtitle={`单笔最大风险：${fmt(settings.maxRiskPct, 2)}%`} />
        <KpiCard title="已平仓胜率" value={`${fmt(kpis.winRate * 100, 1)}%`} subtitle={`${kpis.closedCount} 笔已平仓`} />
        <KpiCard title="Profit Factor" value={kpis.profitFactor === Infinity ? "∞" : fmt(kpis.profitFactor, 2)} subtitle={`平均R：${fmt(kpis.avgR, 2)}`} />
        <KpiCard title="累计已实现" value={`${fmt(kpis.realizedPnl, 0)} ${settings.currency}`} subtitle={`最大回撤：${fmt(kpis.maxDrawdownPct * 100, 1)}%`} />
      </div>
    </div>
  );
}

function KpiCard({ title, value, subtitle }) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-4 grid gap-1">
        <div className="text-sm text-muted-foreground">{title}</div>
        <div className="text-xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </CardContent>
    </Card>
  );
}

function Dashboard({ kpis, trades, currency }) {
  const eqSeries = useMemo(() => kpis.equityCurve, [kpis.equityCurve]);
  const modelPie = useMemo(() => {
    const t = trades.filter((x) => x.status === "closed");
    const by = t.reduce(
      (acc, x) => {
        const k = x.model;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      },
      /** @type {Record<string, number>} */ ({})
    );
    return [
      { name: "趋势", value: by.trend || 0 },
      { name: "反弹", value: by.rebound || 0 },
    ];
  }, [trades]);

  const rBars = useMemo(() => {
    const t = trades
      .filter((x) => x.status === "closed")
      .slice()
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return t.map((x, i) => ({ i: i + 1, R: Number(x.rMultiple || 0) }));
  }, [trades]);

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4 grid gap-3">
            <SectionTitle title="权益曲线（已实现）" subtitle="基于已平仓交易累计（本地估算）" />
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={eqSeries} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="i" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Line type="monotone" dataKey="equity" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xs text-muted-foreground">
              提示：这是操作台复盘用曲线，真实账户会受加减仓、手续费等影响。
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4 grid gap-3">
            <SectionTitle title="模型分布（已平仓）" subtitle="你更常用哪种模型？" />
            <div className="h-72 flex items-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip />
                  <Pie data={modelPie} dataKey="value" nameKey="name" innerRadius={60} outerRadius={100} paddingAngle={4}>
                    {modelPie.map((_, idx) => (
                      <Cell key={idx} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xs text-muted-foreground">建议：保持“趋势 / 反弹”分开复盘，别混模型。</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4 grid gap-3">
            <SectionTitle title="R 值序列" subtitle="每笔交易的收益/风险倍数（R）" />
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rBars} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="i" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="R" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xs text-muted-foreground">
              R=1 表示赚到 1 倍风险；R=-1 表示亏 1 倍风险。
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4 grid gap-3">
            <SectionTitle title="关键统计" subtitle="只统计已平仓交易" />
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="已平仓笔数" value={kpis.closedCount} />
              <Stat label="胜率" value={`${fmt(kpis.winRate * 100, 1)}%`} />
              <Stat label="平均盈利" value={`${fmt(kpis.avgWin, 0)} ${currency}`} />
              <Stat label="平均亏损" value={`${fmt(kpis.avgLoss, 0)} ${currency}`} />
              <Stat label="盈亏比" value={fmt(kpis.winLossRatio, 2)} />
              <Stat label="Profit Factor" value={kpis.profitFactor === Infinity ? "∞" : fmt(kpis.profitFactor, 2)} />
              <Stat label="平均 R" value={fmt(kpis.avgR, 2)} />
              <Stat label="最大回撤" value={`${fmt(kpis.maxDrawdownPct * 100, 1)}%`} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="p-3 rounded-xl border bg-background">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function NewTrade({ settings, draft, setDraft, sizing, score, verdict: v, onSave, onReset }) {
  const items = draft.model === "trend" ? TREND_ITEMS : REBOUND_ITEMS;

  function setField(k, val) {
    setDraft((d) => ({ ...d, [k]: val }));
  }

  function toggleCheck(key) {
    setDraft((d) => ({ ...d, checklist: { ...d.checklist, [key]: !d.checklist[key] } }));
  }

  function setModel(model) {
    setDraft((d) => ({
      ...d,
      model,
      checklist: makeChecklist(model),
    }));
  }

  function setSharesManual(v) {
    setDraft((d) => ({ ...d, sizeShares: v, _manualShares: true }));
  }

  function setPctManual(v) {
    setDraft((d) => ({ ...d, positionPct: v, _manualPct: true }));
  }

  const riskPct = useMemo(() => {
    const e = Number(settings.equity);
    const riskMoney = Number(sizing.riskMoney);
    return e > 0 ? (riskMoney / e) * 100 : 0;
  }, [settings.equity, sizing.riskMoney]);

  return (
    <div className="grid gap-6">
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 grid gap-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <SectionTitle title="新建交易计划" subtitle="先选模型 → 再打分 → 再算仓位 → 最后才下单" />
            <TonePill v={v} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input placeholder="股票代码（如 600089）" value={draft.symbol} onChange={(e) => setField("symbol", e.target.value)} />
            <Input placeholder="股票名称（可选）" value={draft.name} onChange={(e) => setField("name", e.target.value)} />
            <Input placeholder="行业/赛道" value={draft.industry} onChange={(e) => setField("industry", e.target.value)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Select value={draft.timeframe} onValueChange={(x) => setField("timeframe", x)}>
              <SelectTrigger>
                <SelectValue placeholder="周期" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="swing">波段（2–4周）</SelectItem>
                <SelectItem value="mid">中线（1–3月）</SelectItem>
              </SelectContent>
            </Select>

            <Select value={draft.model} onValueChange={(x) => setModel(/** @type {ModelType} */ (x))}>
              <SelectTrigger>
                <SelectValue placeholder="模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="trend">趋势模型A</SelectItem>
                <SelectItem value="rebound">反弹模型B</SelectItem>
              </SelectContent>
            </Select>

            <Input
              type="number"
              placeholder="当前价（可选）"
              value={draft.priceNow || ""}
              onChange={(e) => setField("priceNow", Number(e.target.value))}
            />

            <div className="flex items-center justify-between rounded-xl border px-3 py-2">
              <div className="text-sm text-muted-foreground">模型得分</div>
              <div className="text-lg font-semibold">{score}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input type="number" placeholder="计划入场价" value={draft.entry || ""} onChange={(e) => setField("entry", Number(e.target.value))} />
            <Input type="number" placeholder="止损价（必填）" value={draft.stop || ""} onChange={(e) => setField("stop", Number(e.target.value))} />
            <Input type="number" placeholder="目标价（可选）" value={draft.target || ""} onChange={(e) => setField("target", Number(e.target.value))} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl border p-3 grid gap-1">
              <div className="text-xs text-muted-foreground">单股风险（|入场-止损|）</div>
              <div className="text-lg font-semibold">{fmt(sizing.riskPerShare, 4)}</div>
            </div>
            <div className="rounded-2xl border p-3 grid gap-1">
              <div className="text-xs text-muted-foreground">最大允许亏损（本笔）</div>
              <div className="text-lg font-semibold">{fmt(sizing.riskMoney, 0)} {settings.currency}</div>
              <div className="text-xs text-muted-foreground">= 权益 × {fmt(settings.maxRiskPct, 2)}%</div>
            </div>
            <div className="rounded-2xl border p-3 grid gap-1">
              <div className="text-xs text-muted-foreground">建议数量（按手数取整）</div>
              <div className="text-lg font-semibold">{fmt(sizing.shares, 0)}</div>
              <div className="text-xs text-muted-foreground">手数：{settings.lotSize}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              type="number"
              placeholder="计划数量（手/股/张）"
              value={draft.sizeShares || ""}
              onChange={(e) => setSharesManual(Number(e.target.value))}
            />
            <Input
              type="number"
              placeholder="计划仓位（% of equity）"
              value={draft.positionPct ? fmt(draft.positionPct, 2) : ""}
              onChange={(e) => setPctManual(Number(e.target.value))}
            />
          </div>

          <div className="text-xs text-muted-foreground">
            风控提示：无止损不允许下单；反弹模型建议总仓 ≤30%，趋势模型可逐步加仓但建议 ≤60%。
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 grid gap-3">
          <SectionTitle title="模型清单（打勾即得分）" subtitle={draft.model === "trend" ? "趋势票：只在回踩确认加仓" : "反弹票：只用轻仓试错"} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {items.map((it) => (
              <label key={it.key} className="flex items-center gap-2 rounded-xl border p-3">
                <Checkbox checked={!!draft.checklist[it.key]} onCheckedChange={() => toggleCheck(it.key)} />
                <div className="flex-1">
                  <div className="text-sm">{it.label}</div>
                  <div className="text-xs text-muted-foreground">权重：{it.weight}</div>
                </div>
              </label>
            ))}
          </div>

          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mt-2">
            <div className="flex items-center gap-3">
              <TonePill v={v} />
              <div className="text-sm text-muted-foreground">本笔风险占比：{fmt(riskPct, 2)}%</div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={onReset}>
                重置
              </Button>
              <Button onClick={onSave}>保存到交易日志</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 grid gap-3">
          <SectionTitle title="备注与标签" subtitle="把“入场理由”和“触发信号”写清楚，复盘才有价值" />
          <Input
            placeholder="标签（逗号分隔，如：主线,突破,回踩）"
            value={(draft.tags || []).join(",")}
            onChange={(e) => setField("tags", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))}
          />
          <Textarea placeholder="备注（入场理由、触发信号、关键位、计划加减仓条件…）" value={draft.notes} onChange={(e) => setField("notes", e.target.value)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Trades({ trades, currency, filter, setFilter, onDelete, onClose, onEdit }) {
  const [closeId, setCloseId] = useState(null);
  const [closePrice, setClosePrice] = useState("");

  return (
    <div className="grid gap-6">
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 grid gap-4">
          <SectionTitle title="交易日志" subtitle="建议：每一笔都写止损、信号与复盘" />

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Input placeholder="搜索（代码/行业/标签/备注）" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />

            <Select value={filter.model} onValueChange={(x) => setFilter((f) => ({ ...f, model: x }))}>
              <SelectTrigger>
                <SelectValue placeholder="模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                <SelectItem value="trend">趋势</SelectItem>
                <SelectItem value="rebound">反弹</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filter.status} onValueChange={(x) => setFilter((f) => ({ ...f, status: x }))}>
              <SelectTrigger>
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="open">持仓中</SelectItem>
                <SelectItem value="closed">已平仓</SelectItem>
              </SelectContent>
            </Select>

            <Input placeholder="按标签过滤（如 回踩）" value={filter.tag} onChange={(e) => setFilter((f) => ({ ...f, tag: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-0 overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b">
                <tr className="text-left">
                  <th className="p-3">标的</th>
                  <th className="p-3">模型</th>
                  <th className="p-3">得分</th>
                  <th className="p-3">入场/止损/目标</th>
                  <th className="p-3">仓位/数量</th>
                  <th className="p-3">状态</th>
                  <th className="p-3">PnL</th>
                  <th className="p-3">R</th>
                  <th className="p-3">操作</th>
                </tr>
              </thead>
              <tbody>
                {trades.length === 0 ? (
                  <tr>
                    <td className="p-6 text-muted-foreground" colSpan={9}>
                      暂无记录。去「新建计划」添加第一笔交易。
                    </td>
                  </tr>
                ) : (
                  trades.map((t) => (
                    <tr key={t.id} className="border-b hover:bg-muted/30">
                      <td className="p-3">
                        <div className="font-semibold">{t.symbol}{t.name ? ` · ${t.name}` : ""}</div>
                        <div className="text-xs text-muted-foreground">{t.industry || "-"} · {t.timeframe === "mid" ? "中线" : "波段"}</div>
                        <div className="text-xs text-muted-foreground">标签：{(t.tags || []).slice(0, 4).join("、") || "-"}</div>
                      </td>
                      <td className="p-3">{t.model === "trend" ? "趋势" : "反弹"}</td>
                      <td className="p-3">
                        <div className="font-semibold">{t.score}</div>
                        <div className="text-xs text-muted-foreground">{verdict(t.model, t.score).text}</div>
                      </td>
                      <td className="p-3">
                        <div>入 {fmt(t.entry, 2)}</div>
                        <div>损 {fmt(t.stop, 2)}</div>
                        <div>目 {t.target ? fmt(t.target, 2) : "-"}</div>
                      </td>
                      <td className="p-3">
                        <div>{fmt(t.positionPct, 2)}%</div>
                        <div className="text-xs text-muted-foreground">{fmt(t.sizeShares, 0)} 股/张</div>
                      </td>
                      <td className="p-3">
                        {t.status === "open" ? (
                          <span className="inline-flex px-2 py-1 rounded-full border text-xs">持仓中</span>
                        ) : (
                          <span className="inline-flex px-2 py-1 rounded-full border text-xs">已平仓</span>
                        )}
                        <div className="text-xs text-muted-foreground mt-1">{new Date(t.createdAt).toLocaleDateString()}</div>
                      </td>
                      <td className="p-3">
                        {t.status === "closed" ? (
                          <span className={Number(t.pnl) >= 0 ? "text-emerald-700" : "text-rose-700"}>
                            {fmt(t.pnl, 0)} {currency}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-3">
                        {t.status === "closed" ? (
                          <span className={Number(t.rMultiple) >= 0 ? "text-emerald-700" : "text-rose-700"}>
                            {fmt(t.rMultiple, 2)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" onClick={() => onEdit(t)}>
                            编辑
                          </Button>
                          {t.status === "open" ? (
                            <Button
                              size="sm"
                              onClick={() => {
                                setCloseId(t.id);
                                setClosePrice("");
                              }}
                            >
                              平仓
                            </Button>
                          ) : null}
                          <Button size="sm" variant="destructive" onClick={() => onDelete(t.id)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!closeId} onOpenChange={(o) => !o && setCloseId(null)}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>平仓</DialogTitle>
            <DialogDescription>输入平仓价，系统会自动计算 PnL 与 R。</DialogDescription>
          </DialogHeader>
          <Input type="number" placeholder="平仓价" value={closePrice} onChange={(e) => setClosePrice(e.target.value)} />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCloseId(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (closeId) onClose(closeId, closePrice);
                setCloseId(null);
              }}
            >
              确认平仓
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditDialog({ trade, currency, lotSize, onClose, onSave }) {
  const [t, setT] = useState(() => ({ ...trade }));

  const items = t.model === "trend" ? TREND_ITEMS : REBOUND_ITEMS;
  const score = useMemo(() => scoreChecklist(t.model, t.checklist), [t.model, t.checklist]);

  useEffect(() => {
    setT((x) => ({ ...x, score }));
  }, [score]);

  const suggested = useMemo(() => {
    // Note: editing dialog doesn't know equity settings; only for recalculating to lot-size.
    return {
      score,
      verdict: verdict(t.model, score),
    };
  }, [t.model, score]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
    >
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="rounded-2xl max-w-3xl">
          <DialogHeader>
            <DialogTitle>编辑交易</DialogTitle>
            <DialogDescription>修改后会自动重新计算得分与（已平仓的）PnL/R。</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="flex items-center justify-between gap-2">
              <TonePill v={suggested.verdict} />
              <div className="text-sm text-muted-foreground">得分：<span className="font-semibold">{score}</span></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Input placeholder="股票代码" value={t.symbol} onChange={(e) => setT((x) => ({ ...x, symbol: e.target.value }))} />
              <Input placeholder="名称" value={t.name} onChange={(e) => setT((x) => ({ ...x, name: e.target.value }))} />
              <Input placeholder="行业" value={t.industry} onChange={(e) => setT((x) => ({ ...x, industry: e.target.value }))} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Select value={t.model} onValueChange={(x) => setT((p) => ({ ...p, model: x, checklist: makeChecklist(x) }))}>
                <SelectTrigger><SelectValue placeholder="模型" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trend">趋势模型A</SelectItem>
                  <SelectItem value="rebound">反弹模型B</SelectItem>
                </SelectContent>
              </Select>

              <Input type="number" placeholder="入场价" value={t.entry || ""} onChange={(e) => setT((x) => ({ ...x, entry: Number(e.target.value) }))} />
              <Input type="number" placeholder="止损价" value={t.stop || ""} onChange={(e) => setT((x) => ({ ...x, stop: Number(e.target.value) }))} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Input type="number" placeholder="目标价" value={t.target || ""} onChange={(e) => setT((x) => ({ ...x, target: Number(e.target.value) }))} />
              <Input type="number" placeholder={`数量（按${lotSize}取整）`} value={t.sizeShares || ""} onChange={(e) => setT((x) => ({ ...x, sizeShares: Number(e.target.value) }))} />
              <Input type="number" placeholder="仓位%" value={t.positionPct ? fmt(t.positionPct, 2) : ""} onChange={(e) => setT((x) => ({ ...x, positionPct: Number(e.target.value) }))} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {items.map((it) => (
                <label key={it.key} className="flex items-center gap-2 rounded-xl border p-3">
                  <Checkbox
                    checked={!!t.checklist[it.key]}
                    onCheckedChange={() => setT((x) => ({ ...x, checklist: { ...x.checklist, [it.key]: !x.checklist[it.key] } }))}
                  />
                  <div className="flex-1">
                    <div className="text-sm">{it.label}</div>
                    <div className="text-xs text-muted-foreground">权重：{it.weight}</div>
                  </div>
                </label>
              ))}
            </div>

            <Input
              placeholder="标签（逗号分隔）"
              value={(t.tags || []).join(",")}
              onChange={(e) => setT((x) => ({ ...x, tags: e.target.value.split(",").map((z) => z.trim()).filter(Boolean) }))}
            />
            <Textarea placeholder="备注" value={t.notes} onChange={(e) => setT((x) => ({ ...x, notes: e.target.value }))} />

            <div className="rounded-xl border p-3 text-sm">
              <div className="font-semibold">如果已平仓</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                <Select value={t.status} onValueChange={(x) => setT((p) => ({ ...p, status: x }))}>
                  <SelectTrigger><SelectValue placeholder="状态" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">持仓中</SelectItem>
                    <SelectItem value="closed">已平仓</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="number" placeholder="平仓价" value={t.exit || ""} onChange={(e) => setT((x) => ({ ...x, exit: Number(e.target.value) }))} />
                <div className="rounded-xl border px-3 py-2 flex items-center justify-between">
                  <span className="text-muted-foreground">PnL</span>
                  <span className={calcPnL(t) >= 0 ? "text-emerald-700 font-semibold" : "text-rose-700 font-semibold"}>
                    {fmt(calcPnL(t), 0)} {currency}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button onClick={() => onSave({ ...t, score })}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function Settings({ settings, onUpdate, onClearAll }) {
  return (
    <div className="grid gap-6">
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 grid gap-4">
          <SectionTitle title="全局风控设置" subtitle="仓位计算会用到这些参数" />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input
              type="number"
              placeholder="账户权益"
              value={settings.equity}
              onChange={(e) => onUpdate({ equity: Number(e.target.value) })}
            />
            <Input
              type="number"
              placeholder="单笔最大风险%"
              value={settings.maxRiskPct}
              onChange={(e) => onUpdate({ maxRiskPct: Number(e.target.value) })}
            />
            <Input
              type="number"
              placeholder="手数/最小单位"
              value={settings.lotSize}
              onChange={(e) => onUpdate({ lotSize: Number(e.target.value) })}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Select value={settings.defaultModel} onValueChange={(x) => onUpdate({ defaultModel: x })}>
              <SelectTrigger><SelectValue placeholder="默认模型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="trend">趋势模型A</SelectItem>
                <SelectItem value="rebound">反弹模型B</SelectItem>
              </SelectContent>
            </Select>

            <Select value={settings.defaultTimeframe} onValueChange={(x) => onUpdate({ defaultTimeframe: x })}>
              <SelectTrigger><SelectValue placeholder="默认周期" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="swing">波段（2–4周）</SelectItem>
                <SelectItem value="mid">中线（1–3月）</SelectItem>
              </SelectContent>
            </Select>

            <Select value={settings.currency} onValueChange={(x) => onUpdate({ currency: x })}>
              <SelectTrigger><SelectValue placeholder="币种" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CNY">CNY</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="HKD">HKD</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-xl border p-3 text-sm text-muted-foreground">
            建议参数：单笔最大风险 0.5%–1.5%。你做中线票，宁可少赚也别回撤太大。
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 grid gap-3">
          <SectionTitle title="数据管理" subtitle="所有数据保存在浏览器本地" />
          <Button variant="destructive" onClick={onClearAll}>清空所有数据</Button>
          <div className="text-xs text-muted-foreground">
            清空后不可恢复。建议定期用右上角“导出”备份。
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Data helpers ----------
function makeChecklist(model) {
  const items = model === "trend" ? TREND_ITEMS : REBOUND_ITEMS;
  const obj = {};
  items.forEach((it) => (obj[it.key] = false));
  return obj;
}

function makeBlankTrade(settings) {
  const model = /** @type {ModelType} */ (settings.defaultModel || "trend");
  return {
    symbol: "",
    name: "",
    industry: "",
    model,
    timeframe: settings.defaultTimeframe || "mid",
    priceNow: 0,
    entry: 0,
    stop: 0,
    target: 0,
    positionPct: 0,
    sizeShares: 0,
    score: 0,
    checklist: makeChecklist(model),
    status: "open",
    exit: 0,
    pnl: 0,
    rMultiple: 0,
    tags: [],
    notes: "",
    // internal flags
    _manualShares: false,
    _manualPct: false,
  };
}

function normalizeTrade(t) {
  const model = t.model === "rebound" ? "rebound" : "trend";
  const checklist = t.checklist && typeof t.checklist === "object" ? t.checklist : makeChecklist(model);
  return {
    ...t,
    symbol: String(t.symbol || "").trim(),
    name: String(t.name || "").trim(),
    industry: String(t.industry || "").trim(),
    model,
    timeframe: t.timeframe === "swing" ? "swing" : "mid",
    priceNow: Number(t.priceNow || 0),
    entry: Number(t.entry || 0),
    stop: Number(t.stop || 0),
    target: Number(t.target || 0),
    positionPct: Number(t.positionPct || 0),
    sizeShares: Number(t.sizeShares || 0),
    score: Number(t.score || scoreChecklist(model, checklist)),
    checklist,
    status: t.status === "closed" ? "closed" : "open",
    exit: Number(t.exit || 0),
    pnl: Number(t.pnl || 0),
    rMultiple: Number(t.rMultiple || 0),
    tags: Array.isArray(t.tags) ? t.tags : String(t.tags || "").split(",").map((x) => x.trim()).filter(Boolean),
    notes: String(t.notes || ""),
    createdAt: Number(t.createdAt || Date.now()),
    updatedAt: Number(t.updatedAt || Date.now()),
  };
}

function computeKPIs(trades, startingEquity) {
  const closed = trades
    .filter((t) => t.status === "closed" && Number(t.exit) > 0 && Number(t.entry) > 0 && Number(t.sizeShares) > 0)
    .slice()
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);

  const realizedPnl = closed.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const winRate = closed.length ? wins.length / closed.length : 0;

  const avgWin = wins.length ? wins.reduce((s, t) => s + Number(t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + Number(t.pnl || 0), 0) / losses.length : 0;

  const winLossRatio = avgLoss === 0 ? (avgWin > 0 ? Infinity : 0) : Math.abs(avgWin / avgLoss);

  const grossWin = wins.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const grossLossAbs = Math.abs(losses.reduce((s, t) => s + Number(t.pnl || 0), 0));
  const profitFactor = grossLossAbs === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLossAbs;

  const avgR = closed.length ? closed.reduce((s, t) => s + Number(t.rMultiple || 0), 0) / closed.length : 0;

  // equity curve + drawdown
  let eq = Number(startingEquity || 0);
  let peak = eq;
  let maxDD = 0;
  const equityCurve = [{ i: 0, equity: eq }];

  closed.forEach((t, idx) => {
    eq += Number(t.pnl || 0);
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    maxDD = Math.max(maxDD, dd);
    equityCurve.push({ i: idx + 1, equity: eq });
  });

  return {
    closedCount: closed.length,
    winRate,
    realizedPnl,
    avgWin,
    avgLoss,
    winLossRatio,
    profitFactor,
    avgR,
    equityCurve,
    maxDrawdownPct: maxDD,
  };
}
