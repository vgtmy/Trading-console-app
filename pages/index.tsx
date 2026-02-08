import React, { useMemo, useState } from "react";

type ModelType = "trend" | "rebound";

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

export default function Home() {
  const [symbol, setSymbol] = useState("");
  const [model, setModel] = useState<ModelType>("trend");
  const [check, setCheck] = useState<Record<string, boolean>>({});

  const items = model === "trend" ? TREND : REBOUND;
  const s = useMemo(() => score(model, check), [model, check]);
  const v = useMemo(() => verdict(model, s), [model, s]);

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>个人交易操作台（在线版）</h1>
      <p style={{ color: "#666", marginTop: 0 }}>先把站跑通（不再 404），再上完整版 UI。</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="股票代码（如 600089）"
          style={{ padding: 12, border: "1px solid #ddd", borderRadius: 10 }}
        />
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value as ModelType);
            setCheck({});
          }}
          style={{ padding: 12, border: "1px solid #ddd", borderRadius: 10 }}
        >
          <option value="trend">趋势模型A</option>
          <option value="rebound">反弹模型B</option>
        </select>
      </div>

      <div style={{ marginTop: 16, padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <div>模型得分：<b>{s}</b></div>
          <div>结论：<b>{v}</b></div>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {items.map((it) => (
          <label key={it.k} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, display: "flex", gap: 10 }}>
            <input
              type="checkbox"
              checked={!!check[it.k]}
              onChange={() => setCheck((c) => ({ ...c, [it.k]: !c[it.k] }))}
            />
            <div>
              <div>{it.t}</div>
              <div style={{ color: "#888", fontSize: 12 }}>权重：{it.w}</div>
            </div>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 18, color: "#888", fontSize: 12 }}>
        说明：这版是“修复 404 的保底版本”。跑通后我再把你完整版的交易日志/仪表盘/导入导出全部加回去。
      </div>
    </div>
  );
}
