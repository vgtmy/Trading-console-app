import React, { useEffect, useMemo, useRef, useState } from "react";

type ModelType = "trend" | "rebound";
type Status = "open" | "closed";
type Side = "long" | "short";

type Trade = {
  side: Side;
  
  feePct: number;        // 双边手续费（%）
  exitFeePct: number;    // 平仓额外费用（%）例如A股印花税
  slippage: number;      // 滑点（每股/每张，金额）

  id: string;
  createdAt: number;
  updatedAt: number;

  symbol: string;
  name?: string;
  industry?: string;

  model: ModelType;
  timeframe: "mid" | "swing";

  entry: number;
  stop: number;
  target?: number;

  equity: number;        // 账户权益（用于复盘）
  maxRiskPct: number;    // 单笔最大风险%
  lotSize: number;       // 手数/最小单位

  size: number;          // 数量（股/张）
  positionPct: number;   // 仓位%（占权益）

  score: number;
  checklist: Record<string, boolean>;
  tags: string[];

  status: Status;
  exit?: number;
  pnl?: number;
  r?: number;

  notes?: string;
};

const LS_KEY = "trading_ops_console_v2";

const TREND = [
  { k: "maBull", t: "均线多头（5>10>20）", w: 20 },
  { k: "aboveMA20", t: "股价站上MA20", w: 15 },
  { k: "weeklyUp", t: "周线趋势向上", w: 15 },
  { k: "breakout", t: "平台/箱体突破", w: 15 },
  { k: "breakoutVol", t: "突破放量", w: 15 },
  { k: "pullbackVol", t: "回调缩量", w: 10 },
  { k: "momentumOk", t: "动能健康（MACD/RSI）", w: 10 },
];

const REBOUND = [
  { k: "drawdown30", t: "跌幅>30%", w: 20 },
  { k: "support", t: "接近历史支撑区", w: 20 },
  { k: "valueOk", t: "估值安全（PE/PB合理）", w: 10 },
  { k: "stopK", t: "止跌K线（长下影/反包）", w: 20 },
  { k: "firstVolUp", t: "首次放量阳线/反转量", w: 15 },
  { k: "macdTurn", t: "MACD低位金叉/底背离", w: 15 },
];

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}
function fmt(n: any, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  return x.toFixed(d);
}
function makeChecklist(model: ModelType) {
  const items = model === "trend" ? TREND : REBOUND;
  const o: Record<string, boolean> = {};
  items.forEach((it) => (o[it.k] = false));
  return o;
}
function score(model: ModelType, c: Record<string, boolean>) {
  const items = model === "trend" ? TREND : REBOUND;
  const total = items.reduce((s, x) => s + x.w, 0);
  const got = items.reduce((s, x) => s + (c[x.k] ? x.w : 0), 0);
  return Math.round((got / total) * 100);
}
function verdict(model: ModelType, s: number) {
  if (model === "trend") {
    if (s >= 80) return "✅ 可建仓";
    if (s >= 70) return "⚠️ 轻仓试错";
    return "❌ 放弃";
  } else {
    if (s >= 75) return "✅ 可试仓（反弹）";
    if (s >= 65) return "⚠️ 观察（等信号）";
    return "❌ 放弃";
  }
}

type Side = "long" | "short";

function calcSizing(
  equity: number,
  maxRiskPct: number,
  entry: number,
  stop: number,
  lotSize: number,
  side: Side = "long",
  feePct: number = 0,
  exitFeePct: number = 0,
  slippage: number = 0
) {
  // 容错
  const e = Number(entry || 0);
  const s = Number(stop || 0);
  const lot = Math.max(1, Number(lotSize || 1));
  const fee = Number(feePct || 0);
  const exitFee = Number(exitFeePct || 0);
  const slip = Number(slippage || 0);

  // 价格风险：做多 entry-stop；做空 stop-entry
  const priceRisk = side === "long" ? (e - s) : (s - e);

  // 成本风险：按“止损触发时”估算每股成本（简化模型）
  // 手续费双边：entry 和 stop 两侧都算
  // 平仓额外费（印花税）：按 stop 名义（止损卖出）算
  // 滑点：进出各一次
  const costRisk =
    e * (fee / 100) +
    s * (fee / 100) +
    s * (exitFee / 100) +
    2 * slip;

  const riskPer = Math.max(0, priceRisk + costRisk);

  const riskMoney = equity * (maxRiskPct / 100);

  // 风险为0时避免除0
  const rawSize = riskPer > 0 ? Math.floor(riskMoney / riskPer) : 0;
  const size = Math.floor(rawSize / lot) * lot;

  const posPct = equity > 0 ? (size * e) / equity * 100 : 0;

  return { riskPer, riskMoney, size, posPct };
}


function calcCosts(entry: number, exit: number, size: number, feePct: number, exitFeePct: number, slippage: number) {
  const notionalEntry = entry * size;
  const notionalExit = exit * size;

  const fee = (notionalEntry + notionalExit) * (feePct / 100); // 双边手续费
  const exitFee = notionalExit * (exitFeePct / 100);           // 平仓额外费（如印花税）
  const slip = Math.abs(slippage) * size * 2;                  // 进出各一次滑点（简单模型）

  return fee + exitFee + slip;
}

function calcPnL(entry: number, exit: number, size: number, side: Side, feePct: number, exitFeePct: number, slippage: number) {
  if (!entry || !exit || !size) return 0;
  const gross = side === "long" ? (exit - entry) * size : (entry - exit) * size;
  const costs = calcCosts(entry, exit, size, feePct, exitFeePct, slippage);
  return gross - costs;
}

function calcR(entry: number, stop: number, exit: number, side: Side, feePct: number, exitFeePct: number, slippage: number) {
  const riskPer =
    side === "long" ? (entry - stop) : (stop - entry); // 做空止损通常在 entry 上方

  if (!riskPer || riskPer <= 0) return 0;

  // 用“扣除成本后的每股收益”计算更贴近真实
  const pnl = calcPnL(entry, exit, 1, side, feePct, exitFeePct, slippage); // size=1 的净利润
  return pnl / riskPer;
}

export default function TradingConsole() {
  const [settings, setSettings] = useState(() => ({
    equity: 100000,
    maxRiskPct: 1.0,
    lotSize: 100,
    
    feePct: 0.03,      // 默认：双边手续费 0.03%
    exitFeePct: 0.10,  // 默认：平仓额外费用 0.10%（A股印花税常见量级，可自己改）
    slippage: 0.01     // 默认：滑点 0.01 元/股（自己改）
    
  }));

  const [trades, setTrades] = useState<Trade[]>([]);
  const [tab, setTab] = useState<"dashboard" | "new" | "log" | "settings">("dashboard");

  // draft
  const [draft, setDraft] = useState(() => ({
  symbol: "",
  name: "",
  industry: "",
  model: "trend" as ModelType,
  timeframe: "mid" as "mid" | "swing",

  side: "long" as Side,

  entry: 0,
  stop: 0,
  target: 0,

  feePct: settings.feePct,
  exitFeePct: settings.exitFeePct,
  slippage: settings.slippage,

  checklist: makeChecklist("trend"),
  tags: [] as string[],
  notes: "",
}));


  const fileRef = useRef<HTMLInputElement | null>(null);

  // load/save
  useEffect(() => {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.settings) setSettings(data.settings);
      if (Array.isArray(data.trades)) setTrades(data.trades);
    } catch {}
  }, []);
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ settings, trades }));
  }, [settings, trades]);

  const items = draft.model === "trend" ? TREND : REBOUND;
  const s = useMemo(() => score(draft.model, draft.checklist), [draft.model, draft.checklist]);
  const sizing = useMemo(
   () =>
     calcSizing(
     settings.equity,
     settings.maxRiskPct,
     Number(draft.entry),
     Number(draft.stop)         
     settings.lotSize,
     draft.side,
     Number(draft.feePct),
     Number(draft.exitFeePct),
     Number(draft.slippage)
    ),
  [
     settings.equity,
     settings.maxRiskPct,
     settings.lotSize,
     draft.entry,
     draft.stop,
     draft.side,
     draft.feePct,
     draft.exitFeePct,
     draft.slippage,
  ]
);
    
  function resetDraft() {
    setDraft({
      symbol: "",
      name: "",
      industry: "",
      model: "trend",
      timeframe: "mid",
      side: "long",
      entry: 0,
      stop: 0,
      target: 0,
      feePct: settings.feePct,
      exitFeePct: settings.exitFeePct,
      slippage: settings.slippage,
      checklist: makeChecklist("trend"),
      tags: [],
      notes: "",
    });
  }

  function addTrade() {
    if (!draft.symbol.trim()) return alert("请填写股票代码/标的。");
    if (!draft.stop || draft.stop <= 0) return alert("止损价必填（无止损不允许下单）。");
    if (!draft.entry || draft.entry <= 0) return alert("入场价必填。");

    // ===== 多空方向止损逻辑校验 =====
    if (draft.side === "short" && Number(draft.stop) <= Number(draft.entry)) {
      return alert("做空时止损一般应高于入场价（stop > entry）。");
    }
    if (draft.side === "long" && Number(draft.stop) >= Number(draft.entry)) {
      return alert("做多时止损一般应低于入场价（stop < entry）。");
    }
    // ==============================

    const now = Date.now();
    const t: Trade = {
      id: uid(),
      createdAt: now,
      updatedAt: now,

      symbol: draft.symbol.trim(),
      name: draft.name?.trim(),
      industry: draft.industry?.trim(),

      model: draft.model,
      timeframe: draft.timeframe,

      side: draft.side,
      feePct: Number(draft.feePct),
      exitFeePct: Number(draft.exitFeePct),
      slippage: Number(draft.slippage),


      entry: Number(draft.entry),
      stop: Number(draft.stop),
      target: draft.target ? Number(draft.target) : undefined,

      equity: settings.equity,
      maxRiskPct: settings.maxRiskPct,
      lotSize: settings.lotSize,

      size: sizing.size,
      positionPct: sizing.posPct,

      score: s,
      checklist: draft.checklist,
      tags: draft.tags,
      notes: draft.notes,

      status: "open",
    };

    setTrades((x) => [t, ...x]);
    resetDraft();
    setTab("log");
  }

  function delTrade(id: string) {
    if (!confirm("确定删除这笔交易？")) return;
    setTrades((x) => x.filter((t) => t.id !== id));
  }

  function closeTrade(id: string) {
    const exitStr = prompt("输入平仓价：");
    if (!exitStr) return;
    const exit = Number(exitStr);
    if (!exit || exit <= 0) return alert("平仓价无效。");

    setTrades((x) =>
      x.map((t) => {
        if (t.id !== id) return t;
        const pnl = calcPnL(t.entry, exit, t.size, t.side, t.feePct, t.exitFeePct, t.slippage);
        const r = calcR(t.entry, t.stop, exit, t.side, t.feePct, t.exitFeePct, t.slippage);

        return { ...t, status: "closed", exit, pnl, r, updatedAt: Date.now() };
      })
    );
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify({ settings, trades }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trading_ops_export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(file: File) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(String(r.result || "{}"));
        if (data.settings) setSettings(data.settings);
        if (Array.isArray(data.trades)) setTrades(data.trades);
        alert("导入成功 ✅");
      } catch {
        alert("导入失败：文件格式不正确");
      }
    };
    r.readAsText(file);
  }

  const kpi = useMemo(() => {
    const closed = trades.filter((t) => t.status === "closed" && typeof t.pnl === "number");
    const wins = closed.filter((t) => (t.pnl || 0) > 0);
    const losses = closed.filter((t) => (t.pnl || 0) < 0);
    const winRate = closed.length ? wins.length / closed.length : 0;

    const grossWin = wins.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossLossAbs = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
    const profitFactor = grossLossAbs === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLossAbs;

    const avgR = closed.length ? closed.reduce((s, t) => s + (t.r || 0), 0) / closed.length : 0;

    return { closedCount: closed.length, winRate, profitFactor, avgR, grossWin, grossLossAbs };
  }, [trades]);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "end", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>个人交易操作台</div>
          <div style={{ color: "#666", fontSize: 13 }}>双模型 · 风控仓位 · 交易日志 · 统计复盘（本地保存）</div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportJSON} style={btn2}>导出</button>
          <button onClick={() => fileRef.current?.click()} style={btn2}>导入</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importJSON(f); e.currentTarget.value = ""; }} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 14 }}>
        <Card title="账户权益" value={`${fmt(settings.equity, 0)}`} sub={`单笔风险：${fmt(settings.maxRiskPct, 2)}%`} />
        <Card title="已平仓胜率" value={`${fmt(kpi.winRate * 100, 1)}%`} sub={`${kpi.closedCount} 笔`} />
        <Card title="Profit Factor" value={kpi.profitFactor === Infinity ? "∞" : fmt(kpi.profitFactor, 2)} sub={`平均R：${fmt(kpi.avgR, 2)}`} />
        <Card title="手数单位" value={`${settings.lotSize}`} sub="用于仓位取整" />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <TabButton onClick={() => setTab("dashboard")} active={tab === "dashboard"}>仪表盘</TabButton>
        <TabButton onClick={() => setTab("new")} active={tab === "new"}>新建计划</TabButton>
        <TabButton onClick={() => setTab("log")} active={tab === "log"}>交易日志</TabButton>
        <TabButton onClick={() => setTab("settings")} active={tab === "settings"}>设置</TabButton>
      </div>

      {tab === "dashboard" && (
        <div style={{ marginTop: 14 }}>
          <Panel>
            <h3 style={{ margin: 0 }}>关键统计（已平仓）</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginTop: 10 }}>
              <Mini label="胜率" value={`${fmt(kpi.winRate * 100, 1)}%`} />
              <Mini label="Profit Factor" value={kpi.profitFactor === Infinity ? "∞" : fmt(kpi.profitFactor, 2)} />
              <Mini label="总盈利" value={`${fmt(kpi.grossWin, 0)}`} />
              <Mini label="总亏损" value={`${fmt(kpi.grossLossAbs, 0)}`} />
            </div>
            <div style={{ color: "#888", fontSize: 12, marginTop: 8 }}>
              提示：这是自用复盘控制台，后续可加手续费/滑点与云同步。
            </div>
          </Panel>
        </div>
      )}

      {tab === "new" && (
        <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
          <Panel>
            <h3 style={{ margin: 0 }}>新建交易计划</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
              <input style={inp} placeholder="代码（如 600089）" value={draft.symbol} onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value }))} />
              <input style={inp} placeholder="名称（可选）" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              <input style={inp} placeholder="行业（可选）" value={draft.industry} onChange={(e) => setDraft((d) => ({ ...d, industry: e.target.value }))} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
              <select style={inp} value={draft.timeframe} onChange={(e) => setDraft((d) => ({ ...d, timeframe: e.target.value as any }))}>
                <option value="mid">中线（1–3月）</option>
                <option value="swing">波段（2–4周）</option>
              </select>

              <select style={inp} value={draft.model} onChange={(e) => {
                const m = e.target.value as ModelType;
                setDraft((d) => ({ ...d, model: m, checklist: makeChecklist(m) }));
              }}>
                <option value="trend">趋势模型A</option>
                <option value="rebound">反弹模型B</option>
              </select>

              <div style={{ ...miniBox }}>
                <div style={{ color: "#666", fontSize: 12 }}>模型得分</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{s}</div>
              </div>

              <div style={{ ...miniBox }}>
                <div style={{ color: "#666", fontSize: 12 }}>结论</div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{verdict(draft.model, s)}</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
              <input style={inp} type="number" placeholder="入场价（必填）" value={draft.entry || ""} onChange={(e) => setDraft((d) => ({ ...d, entry: Number(e.target.value) }))} />
              <input style={inp} type="number" placeholder="止损价（必填）" value={draft.stop || ""} onChange={(e) => setDraft((d) => ({ ...d, stop: Number(e.target.value) }))} />
              <input style={inp} type="number" placeholder="目标价（可选）" value={draft.target || ""} onChange={(e) => setDraft((d) => ({ ...d, target: Number(e.target.value) }))} />
            </div>

            {/* ===== 成本与方向设置 ===== */}
           <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginTop: 10 }}>

          <select
            style={inp}
            value={draft.side}
            onChange={(e) => setDraft(d => ({ ...d, side: e.target.value as any }))}
      >
        <input
          style={inp}
          type="number"
          placeholder="手续费%（双边）"
          value={draft.feePct}
          onChange={(e) => setDraft(d => ({ ...d, feePct: Number(e.target.value) }))}
       />

       <input
         style={inp}
         ype="number"
         placeholder="滑点/每股"
         value={draft.slippage}
         onChange={(e) => setDraft(d => ({ ...d, slippage: Number(e.target.value) }))}
       />

      <input
        style={inp}
        type="number"
        placeholder="平仓额外费%（印花税）"
        value={draft.exitFeePct}
       onChange={(e) => setDraft(d => ({ ...d, exitFeePct: Number(e.target.value) }))}
      />
</div>


            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 10 }}>
              <Mini label="单股风险" value={fmt(sizing.riskPer, 4)} />
              <Mini label="本笔最大亏损" value={fmt(sizing.riskMoney, 0)} />
              <Mini label="建议数量(取整)" value={fmt(sizing.size, 0)} />
              <Mini label="建议仓位%" value={fmt(sizing.posPct, 2)} />
            </div>
          </Panel>

          <Panel>
            <h3 style={{ margin: 0 }}>模型清单（打勾得分）</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              {items.map((it) => (
                <label key={it.k} style={checkItem}>
                  <input
                    type="checkbox"
                    checked={!!draft.checklist[it.k]}
                    onChange={() => setDraft((d) => ({ ...d, checklist: { ...d.checklist, [it.k]: !d.checklist[it.k] } }))}
                  />
                  <div>
                    <div style={{ fontWeight: 700 }}>{it.t}</div>
                    <div style={{ fontSize: 12, color: "#777" }}>权重：{it.w}</div>
                  </div>
                </label>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <input
                style={inp}
                placeholder="标签（逗号分隔，如：主线,突破,回踩）"
                value={draft.tags.join(",")}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
                  }))
                }
              />
            </div>

            <textarea
              style={{ ...inp, height: 90, marginTop: 10 }}
              placeholder="备注（入场理由、触发信号、关键位、加减仓条件…）"
              value={draft.notes}
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            />

            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button style={btn2} onClick={resetDraft}>重置</button>
              <button style={btn1} onClick={addTrade}>保存到交易日志</button>
            </div>
          </Panel>
        </div>
      )}

      {tab === "log" && (
        <div style={{ marginTop: 14 }}>
          <Panel>
            <h3 style={{ margin: 0 }}>交易日志</h3>
            {trades.length === 0 ? (
              <div style={{ color: "#666", marginTop: 10 }}>暂无记录。去「新建计划」添加第一笔交易。</div>
            ) : (
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#666" }}>
                      <th style={th}>标的</th>
                      <th style={th}>模型</th>
                      <th style={th}>得分</th>
                      <th style={th}>入/损/目</th>
                      <th style={th}>数量/仓位</th>
                      <th style={th}>状态</th>
                      <th style={th}>PnL</th>
                      <th style={th}>R</th>
                      <th style={th}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id} style={{ borderTop: "1px solid #eee" }}>
                        <td style={td}>
                          <div style={{ fontWeight: 800 }}>{t.symbol}{t.name ? ` · ${t.name}` : ""}</div>
                          <div style={{ color: "#777", fontSize: 12 }}>{t.industry || "-"} · {t.timeframe === "mid" ? "中线" : "波段"}</div>
                          <div style={{ color: "#999", fontSize: 12 }}>标签：{(t.tags || []).join("、") || "-"}</div>
                        </td>
                        <td style={td}>{t.model === "trend" ? "趋势" : "反弹"}</td>
                        <td style={td}>
                          <div style={{ fontWeight: 800 }}>{t.score}</div>
                          <div style={{ color: "#777", fontSize: 12 }}>{verdict(t.model, t.score)}</div>
                        </td>
                        <td style={td}>
                          <div>入 {fmt(t.entry, 2)}</div>
                          <div>损 {fmt(t.stop, 2)}</div>
                          <div>目 {t.target ? fmt(t.target, 2) : "-"}</div>
                        </td>
                        <td style={td}>
                          <div>{fmt(t.size, 0)}</div>
                          <div style={{ color: "#777", fontSize: 12 }}>{fmt(t.positionPct, 2)}%</div>
                        </td>
                        <td style={td}>
                          {t.status === "open" ? "持仓中" : "已平仓"}
                          <div style={{ color: "#999", fontSize: 12 }}>{new Date(t.createdAt).toLocaleDateString()}</div>
                        </td>
                        <td style={td}>
                          {t.status === "closed" ? (
                            <span style={{ color: (t.pnl || 0) >= 0 ? "#047857" : "#b91c1c", fontWeight: 800 }}>
                              {fmt(t.pnl, 0)}
                            </span>
                          ) : "-"}
                        </td>
                        <td style={td}>
                          {t.status === "closed" ? (
                            <span style={{ color: (t.r || 0) >= 0 ? "#047857" : "#b91c1c", fontWeight: 800 }}>
                              {fmt(t.r, 2)}
                            </span>
                          ) : "-"}
                        </td>
                        <td style={td}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {t.status === "open" && <button style={btn1s} onClick={() => closeTrade(t.id)}>平仓</button>}
                            <button style={btn2s} onClick={() => delTrade(t.id)}>删除</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}

      {tab === "settings" && (
        <div style={{ marginTop: 14 }}>
          <Panel>
            <h3 style={{ margin: 0 }}>全局风控设置</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
              <input style={inp} type="number" value={settings.equity} onChange={(e) => setSettings((s) => ({ ...s, equity: Number(e.target.value) }))} placeholder="账户权益" />
              <input style={inp} type="number" value={settings.maxRiskPct} onChange={(e) => setSettings((s) => ({ ...s, maxRiskPct: Number(e.target.value) }))} placeholder="单笔最大风险%" />
              <input style={inp} type="number" value={settings.lotSize} onChange={(e) => setSettings((s) => ({ ...s, lotSize: Number(e.target.value) }))} placeholder="手数/最小单位" />
            </div>
            <div style={{ color: "#888", fontSize: 12, marginTop: 8 }}>
              建议：单笔风险 0.5%–1.5%。你做中线票，先保命再谈利润。
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Panel({ children }: { children: any }) {
  return <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 16, padding: 14 }}>{children}</div>;
}
function Card({ title, value, sub }: any) {
  return (
    <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 16, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 900, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{sub}</div>
    </div>
  );
}
function Mini({ label, value }: any) {
  return (
    <div style={miniBox}>
      <div style={{ color: "#666", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 900 }}>{value}</div>
    </div>
  );
}
function TabButton({ active, children, onClick }: any) {
  return (
    <button onClick={onClick} style={{ ...(active ? tabOn : tabOff) }}>
      {children}
    </button>
  );
}

const inp: React.CSSProperties = { padding: 12, border: "1px solid #ddd", borderRadius: 12, width: "100%" };
const miniBox: React.CSSProperties = { border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fafafa" };
const checkItem: React.CSSProperties = { border: "1px solid #eee", borderRadius: 14, padding: 12, display: "flex", gap: 10, alignItems: "flex-start", background: "#fff" };

const btn1: React.CSSProperties = { padding: "10px 14px", borderRadius: 12, border: "1px solid #111", background: "#111", color: "#fff", fontWeight: 800 };
const btn2: React.CSSProperties = { padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", color: "#111", fontWeight: 800 };

const btn1s: React.CSSProperties = { padding: "8px 10px", borderRadius: 10, border: "1px solid #111", background: "#111", color: "#fff", fontWeight: 800, fontSize: 12 };
const btn2s: React.CSSProperties = { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff", color: "#111", fontWeight: 800, fontSize: 12 };

const tabOn: React.CSSProperties = { ...btn1s, padding: "10px 12px" };
const tabOff: React.CSSProperties = { ...btn2s, padding: "10px 12px" };

const th: React.CSSProperties = { padding: 10, fontWeight: 700 };
const td: React.CSSProperties = { padding: 10, verticalAlign: "top" };
