'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// ─── Scroll styles ────────────────────────────────────────────────────────────
const SCROLL_CSS = [
  "*::-webkit-scrollbar{width:6px;height:6px}",
  "*::-webkit-scrollbar-track{background:transparent}",
  "*::-webkit-scrollbar-thumb{background:#DDD6FE;border-radius:6px}",
  "*::-webkit-scrollbar-thumb:hover{background:#A78BFA}",
  "*{scrollbar-width:thin;scrollbar-color:#DDD6FE transparent}",
].join(" ");
function GStyle() { return <style>{SCROLL_CSS}</style>; }

// ─── Palette (purple theme) ───────────────────────────────────────────────────
const PUR = '#7C3AED';
const PUR_L = '#EDE9FE';
const PUR_M = '#F5F3FF';
const PUR_B = '#DDD6FE';

// ─── Chart palette ────────────────────────────────────────────────────────────
const P = ['#7C3AED','#4F46E5','#EC4899','#EF4444','#10B981','#F59E0B','#06B6D4','#8B5CF6'];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const uid  = () => Math.random().toString(36).slice(2, 9);
const tstr = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function mdHtml(md) {
  if (!md) return '';
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const inl = (s) =>
    esc(s)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, `<code style='background:#F1F5F9;padding:1px 5px;border-radius:4px;font-size:.9em'>$1</code>`);
  const out = []; let iL = false; let tBuf = [];
  const cL = () => { if (iL) { out.push('</ul>'); iL = false; } };
  const parseRow = (l) => l.trim().split('|').slice(1,-1).map(c => c.trim());
  const flushTable = () => {
    if (!tBuf.length) return;
    const sepIdx = tBuf.findIndex(l => /^\|[-:| ]+\|$/.test(l.trim()));
    const heads = sepIdx > 0 ? tBuf.slice(0, sepIdx) : [];
    const body  = sepIdx >= 0 ? tBuf.slice(sepIdx + 1) : tBuf;
    let t = `<div style='overflow-x:auto;margin:8px 0'><table style='width:100%;border-collapse:collapse;font-size:.85em'>`;
    if (heads.length) {
      t += '<thead>';
      heads.forEach(r => {
        t += '<tr>' + parseRow(r).map(c => `<th style='padding:7px 12px;background:#EDE9FE;color:#4C1D95;font-weight:600;text-align:left;border:1px solid #DDD6FE;white-space:nowrap'>${inl(c)}</th>`).join('') + '</tr>';
      });
      t += '</thead>';
    }
    t += '<tbody>';
    body.forEach((r, i) => {
      t += `<tr style='background:${i%2===0?'#fff':'#F5F3FF'}'>` + parseRow(r).map(c => `<td style='padding:5px 12px;border:1px solid #EDE9FE;vertical-align:top;font-size:.85em'>${inl(c)}</td>`).join('') + '</tr>';
    });
    t += '</tbody></table></div>';
    out.push(t); tBuf = [];
  };
  md.split('\n').forEach((raw) => {
    const l = raw.trimEnd();
    if (l.trim().startsWith('|')) { cL(); tBuf.push(l); return; }
    flushTable();
    if (l.startsWith('### ')) { cL(); out.push(`<h4 style='font-size:.85em;font-weight:700;margin:10px 0 3px;color:${PUR}'>` + inl(l.slice(4)) + '</h4>'); }
    else if (l.startsWith('## ')) { cL(); out.push(`<h3 style='font-size:.92em;font-weight:700;margin:12px 0 4px;color:#0F172A'>` + inl(l.slice(3)) + '</h3>'); }
    else if (/^[-*] .+/.test(l)) {
      if (!iL) { out.push("<ul style='padding-left:14px;margin:4px 0'>"); iL = true; }
      out.push("<li style='margin:3px 0;font-size:.9em'>" + inl(l.replace(/^[-*] /,'')) + '</li>');
    } else if (/^\d+\. .+/.test(l)) { cL(); out.push("<p style='margin:2px 0;font-size:.9em'>" + inl(l) + '</p>'); }
    else if (l.trim() === '') { cL(); out.push('<br/>'); }
    else { cL(); out.push("<p style='margin:3px 0;font-size:.9em'>" + inl(l) + '</p>'); }
  });
  cL(); flushTable();
  return out.join('');
}

function Dots() {
  return (
    <span style={{ display:'inline-flex', gap:3, alignItems:'center' }}>
      {[0,1,2].map((i) => (
        <span key={i} style={{ width:4, height:4, borderRadius:'50%', background:'#A78BFA', display:'inline-block',
          animation:`dt 1.2s ease-in-out ${i*0.2}s infinite` }}/>
      ))}
      <style>{'@keyframes dt{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'}</style>
    </span>
  );
}

// ─── Chart Shell ──────────────────────────────────────────────────────────────
function Shell({ title, subtitle, legend, children }) {
  return (
    <div style={{ background:'#F5F3FF', border:`1px solid ${PUR_B}`, borderRadius:12, padding:'14px 14px 10px', marginTop:12 }}>
      {(title||subtitle) && (
        <div style={{ marginBottom:8 }}>
          {title   && <div style={{ fontSize:12, fontWeight:600, color:'#1E1B4B' }}>{title}</div>}
          {subtitle && <div style={{ fontSize:10, color:'#7C3AED', marginTop:2 }}>{subtitle}</div>}
        </div>
      )}
      {legend && legend.length > 1 && (
        <div style={{ display:'flex', gap:14, marginBottom:10, flexWrap:'wrap' }}>
          {legend.map((l,i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'#4C1D95' }}>
              <div style={{ width:l.line?16:10, height:l.line?3:10, borderRadius:2, background:l.color, flexShrink:0 }}/>
              {l.label}
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────
// Split "SCAN Connections (H0976-001-000)" → ["SCAN Connections", "(H0976-001-000)"]
// so bar chart labels wrap to two lines instead of rotating or overflowing.
function splitBarLabel(l) {
  const s = String(l);
  const m = s.match(/^(.+?)\s+(\([^)]*\).*)$/);
  if (m) return [m[1], m[2]];
  if (s.length > 16) return [s.slice(0, 16), s.slice(16, 30)];
  return [s];
}

function BarChart({ spec }) {
  const { title, subtitle, labels=[], datasets=[], yAxisLabel, yMax, stacked=false } = spec;
  const twoLine = labels.some(l => String(l).length > 12);
  const W=460, H=250, pL=52, pR=20, pT=30, pB=twoLine?72:54, cW=W-pL-pR, cH=H-pT-pB;
  const suffix = yAxisLabel?.includes('%') ? '%' : '';
  const allVals = stacked ? labels.map((_,gi)=>datasets.reduce((s,ds)=>s+(ds.values[gi]??0),0)) : datasets.flatMap(ds=>ds.values??[]);
  const maxY = yMax || Math.ceil(Math.max(...allVals,1)*1.2);
  const numG=labels.length, numS=datasets.length;
  const gW=cW/numG, bW=stacked?Math.min(50,gW*0.55):Math.min(30,(gW*0.72)/numS);
  const gap=(gW-(stacked?bW:bW*numS))/2;
  const step=maxY/5;
  return (
    <Shell title={title} subtitle={subtitle} legend={datasets.map((ds,i)=>({ label:ds.label, color:ds.color||P[i%P.length] }))}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:'visible' }}>
        {Array.from({length:6},(_,i)=>{const val=step*i,y=pT+cH-(val/maxY)*cH;return(<g key={i}><line x1={pL} y1={y} x2={pL+cW} y2={y} stroke="#DDD6FE" strokeWidth="0.5" strokeDasharray={i===0?undefined:'3 3'}/><text x={pL-6} y={y+4} textAnchor="end" fill="#A78BFA" fontSize="10">{Math.round(val)}</text></g>);})}
        <line x1={pL} y1={pT+cH} x2={pL+cW} y2={pT+cH} stroke="#DDD6FE" strokeWidth="1"/>
        {labels.map((label,gi)=>{const gx=pL+gi*gW+gap;let sY=pT+cH;const lx=gx+(stacked?bW:bW*numS)/2,ly=pT+cH+14;const parts=splitBarLabel(label);return(<g key={gi}>
          {datasets.map((ds,di)=>{const val=ds.values[gi]??0,col=ds.color||P[di%P.length];if(stacked){const bH=(val/maxY)*cH,y=sY-bH;sY=y;return(<g key={di}><rect x={gx} y={y} width={bW} height={bH} fill={col} rx="3" opacity="0.9"/>{bH>14&&<text x={gx+bW/2} y={y+bH/2+4} textAnchor="middle" fill="white" fontSize="10" fontWeight="600">{val}{suffix}</text>}</g>);}const bH=(val/maxY)*cH,x=gx+di*bW,y=pT+cH-bH;return(<g key={di}><rect x={x} y={y} width={bW} height={bH} fill={col} rx="3" opacity="0.9"/><text x={x+bW/2} y={y-4} textAnchor="middle" fill={col} fontSize="11" fontWeight="600">{val}{suffix}</text></g>);})}
          <text textAnchor="middle" fill="#6D28D9" fontSize="10">
            {parts.map((part,pi)=><tspan key={pi} x={lx} dy={pi===0?ly:12}>{part}</tspan>)}
          </text>
        </g>);})}
      </svg>
    </Shell>
  );
}

// ─── Line Chart ───────────────────────────────────────────────────────────────
function LineChart({ spec }) {
  const { title, subtitle, labels=[], datasets=[], yAxisLabel, yMax } = spec;
  const W=520,H=290,pL=52,pR=24,pT=36,pB=60,cW=W-pL-pR,cH=H-pT-pB;
  const suffix=yAxisLabel?.includes('%')?'%':'';
  const allVals=datasets.flatMap(ds=>ds.values??[]);
  const maxY=yMax||Math.ceil(Math.max(...allVals,1)*1.2);
  const n=labels.length,xS=n>1?cW/(n-1):cW;
  const xy=(gi,v)=>({x:pL+gi*xS,y:pT+cH-(v/maxY)*cH});
  return (
    <Shell title={title} subtitle={subtitle} legend={datasets.map((ds,i)=>({ label:ds.label, color:ds.color||P[i%P.length], line:true }))}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:'visible' }}>
        {Array.from({length:6},(_,i)=>{const val=(maxY/5)*i,y=pT+cH-(val/maxY)*cH;return(<g key={i}><line x1={pL} y1={y} x2={pL+cW} y2={y} stroke="#DDD6FE" strokeWidth="0.5" strokeDasharray={i===0?undefined:'3 3'}/><text x={pL-6} y={y+4} textAnchor="end" fill="#A78BFA" fontSize="10">{Math.round(val)}</text></g>);})}
        <line x1={pL} y1={pT+cH} x2={pL+cW} y2={pT+cH} stroke="#DDD6FE" strokeWidth="1"/>
        {datasets.map((ds,di)=>{const col=ds.color||P[di%P.length];const pts=ds.values.map((v,gi)=>xy(gi,v??0));const d=pts.reduce((a,pt,i)=>{if(i===0)return `M ${pt.x} ${pt.y}`;const prev=pts[i-1],cx=(prev.x+pt.x)/2;return `${a} C ${cx} ${prev.y} ${cx} ${pt.y} ${pt.x} ${pt.y}`;},'');return(<g key={di}><path d={d} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>{pts.map((pt,gi)=>(<g key={gi}><circle cx={pt.x} cy={pt.y} r="4.5" fill={col}/><circle cx={pt.x} cy={pt.y} r="2" fill="#fff"/><text x={pt.x} y={pt.y-10} textAnchor="middle" fill={col} fontSize="11" fontWeight="600">{ds.values[gi]}{suffix}</text></g>))}</g>);})}
        {labels.map((l,gi)=>(<text key={gi} x={pL+gi*xS} y={pT+cH+16} textAnchor="middle" fill="#6D28D9" fontSize="11">{l}</text>))}
      </svg>
    </Shell>
  );
}

// ─── Area Chart ───────────────────────────────────────────────────────────────
function AreaChart({ spec }) {
  const { title, subtitle, labels=[], datasets=[], yAxisLabel, yMax } = spec;
  const W=520,H=290,pL=52,pR=24,pT=36,pB=60,cW=W-pL-pR,cH=H-pT-pB;
  const allVals=datasets.flatMap(ds=>ds.values??[]);
  const maxY=yMax||Math.ceil(Math.max(...allVals,1)*1.2);
  const n=labels.length,xS=n>1?cW/(n-1):cW;
  const xy=(gi,v)=>({x:pL+gi*xS,y:pT+cH-(v/maxY)*cH});
  const suffix=yAxisLabel?.includes('%')?'%':'';
  return (
    <Shell title={title} subtitle={subtitle} legend={datasets.map((ds,i)=>({ label:ds.label, color:ds.color||P[i%P.length], line:true }))}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:'visible' }}>
        {Array.from({length:6},(_,i)=>{const val=(maxY/5)*i,y=pT+cH-(val/maxY)*cH;return(<g key={i}><line x1={pL} y1={y} x2={pL+cW} y2={y} stroke="#DDD6FE" strokeWidth="0.5" strokeDasharray={i===0?undefined:'3 3'}/><text x={pL-6} y={y+4} textAnchor="end" fill="#A78BFA" fontSize="10">{Math.round(val)}</text></g>);})}
        <line x1={pL} y1={pT+cH} x2={pL+cW} y2={pT+cH} stroke="#DDD6FE" strokeWidth="1"/>
        {datasets.map((ds,di)=>{const col=ds.color||P[di%P.length];const pts=ds.values.map((v,gi)=>xy(gi,v??0));const line=pts.reduce((a,pt,i)=>{if(i===0)return `M ${pt.x} ${pt.y}`;const prev=pts[i-1],cx=(prev.x+pt.x)/2;return `${a} C ${cx} ${prev.y} ${cx} ${pt.y} ${pt.x} ${pt.y}`;},'');return(<g key={di}><path d={`${line} L ${pts[pts.length-1].x} ${pT+cH} L ${pts[0].x} ${pT+cH} Z`} fill={col} opacity="0.2"/><path d={line} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>{pts.map((pt,gi)=>(<g key={gi}><circle cx={pt.x} cy={pt.y} r="4" fill={col}/><circle cx={pt.x} cy={pt.y} r="2" fill="#fff"/><text x={pt.x} y={pt.y-10} textAnchor="middle" fill={col} fontSize="11" fontWeight="600">{ds.values[gi]}{suffix}</text></g>))}</g>);})}
        {labels.map((l,gi)=>(<text key={gi} x={pL+gi*xS} y={pT+cH+16} textAnchor="middle" fill="#6D28D9" fontSize="11">{l}</text>))}
      </svg>
    </Shell>
  );
}

// ─── Pie / Donut ──────────────────────────────────────────────────────────────
function PieChart({ spec }) {
  const { title, subtitle, labels=[], values=[], colors, type='pie' } = spec;
  const isDonut=type==='donut';
  const W=520,H=260,cx=W/2,cy=H/2-8,R=96,iR=isDonut?46:0;
  const cols=colors||P;
  const total=values.reduce((a,b)=>a+b,0)||1;
  const legsPerRow=Math.min(3,values.length);
  let ang=-Math.PI/2;
  // Zero-value slices get a minimum visible arc (~4°) so they appear in the chart.
  // Non-zero slices share the remaining sweep proportionally.
  // Displayed pct label still shows the mathematically correct value.
  const zeroCount=values.filter(v=>v<=0).length;
  const MIN_SW=zeroCount>0?0.07:0;
  const nonZeroSum=values.reduce((s,v)=>s+(v>0?v:0),0)||1;
  const availSw=2*Math.PI-zeroCount*MIN_SW;
  const slices=values.map((v,i)=>{
    const sw=v<=0?MIN_SW:(v/nonZeroSum)*availSw,sa=ang,ea=ang+sw;ang=ea;
    const mid=sa+sw/2,r2=R+20,large=sw>Math.PI?1:0;
    let d='';
    if(sw>=2*Math.PI-0.001){
      // Full-circle edge case: split into two 180° arcs (SVG can't arc to same point)
      const x1=cx+R*Math.cos(sa),y1=cy+R*Math.sin(sa),x2=cx+R*Math.cos(sa+Math.PI),y2=cy+R*Math.sin(sa+Math.PI);
      if(isDonut){const ix1=cx+iR*Math.cos(sa),iy1=cy+iR*Math.sin(sa),ix2=cx+iR*Math.cos(sa+Math.PI),iy2=cy+iR*Math.sin(sa+Math.PI);d=`M ${x1} ${y1} A ${R} ${R} 0 1 1 ${x2} ${y2} A ${R} ${R} 0 1 1 ${x1} ${y1} Z M ${ix1} ${iy1} A ${iR} ${iR} 0 1 0 ${ix2} ${iy2} A ${iR} ${iR} 0 1 0 ${ix1} ${iy1} Z`;}
      else{d=`M ${x1} ${y1} A ${R} ${R} 0 1 1 ${x2} ${y2} A ${R} ${R} 0 1 1 ${x1} ${y1} Z`;}
    } else if(sw>0.001){
      d=`M ${cx+R*Math.cos(sa)} ${cy+R*Math.sin(sa)} A ${R} ${R} 0 ${large} 1 ${cx+R*Math.cos(ea)} ${cy+R*Math.sin(ea)}`+(isDonut?` L ${cx+iR*Math.cos(ea)} ${cy+iR*Math.sin(ea)} A ${iR} ${iR} 0 ${large} 0 ${cx+iR*Math.cos(sa)} ${cy+iR*Math.sin(sa)} Z`:` L ${cx} ${cy} Z`);
    }
    return{d,lx:cx+r2*Math.cos(mid),ly:cy+r2*Math.sin(mid),pct:Math.round((v/total)*100),col:cols[i%cols.length],label:labels[i]||'',value:v};
  });
  return (
    <Shell title={title} subtitle={subtitle}>
      <svg width="100%" viewBox={`0 0 ${W} ${H+Math.ceil(slices.length/legsPerRow)*22+10}`} style={{ overflow:'visible' }}>
        {slices.map((s,i)=>s.d&&(<g key={i}><path d={s.d} fill={s.col} opacity="0.92" stroke="#fff" strokeWidth="1.5" fillRule="evenodd"/>{s.pct>=5&&<text x={s.lx} y={s.ly+4} textAnchor="middle" fill={s.col} fontSize="11" fontWeight="700">{s.pct}%</text>}</g>))}
        {isDonut&&(<><circle cx={cx} cy={cy} r={iR-1} fill="#fff"/><text x={cx} y={cy-4} textAnchor="middle" fill="#1E1B4B" fontSize="20" fontWeight="700">{total}</text><text x={cx} y={cy+14} textAnchor="middle" fill="#A78BFA" fontSize="10">total</text></>)}
        {slices.map((s,i)=>{const col2=i%legsPerRow,row2=Math.floor(i/legsPerRow),lx2=20+col2*((W-40)/legsPerRow);return(<g key={i} transform={`translate(${lx2},${H+row2*22})`}><rect width="10" height="10" rx="2" fill={s.col}/><text x="15" y="9" fill="#4C1D95" fontSize="11">{s.label} ({s.value})</text></g>);})}
      </svg>
    </Shell>
  );
}

// ─── CSV download helper ──────────────────────────────────────────────────────
function downloadCSV(title, subtitle, columns, rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines  = [columns.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
  const csv  = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel UTF-8
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(title || 'table').replace(/[^a-z0-9]/gi, '_')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Data Table ───────────────────────────────────────────────────────────────
function DataTable({ spec }) {
  const { title, subtitle, columns=[], rows=[], highlight=[] } = spec;
  const hl=new Set(highlight);
  return (
    <div style={{ background:PUR_M, border:`1px solid ${PUR_B}`, borderRadius:12, overflow:'hidden', marginTop:12 }}>
      <div style={{ padding:'10px 14px 8px', borderBottom:`1px solid ${PUR_B}`, display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
        <div style={{ minWidth:0 }}>
          {title    && <div style={{ fontSize:12, fontWeight:600, color:'#1E1B4B' }}>{title}</div>}
          {subtitle && <div style={{ fontSize:10, color:PUR, marginTop:2 }}>{subtitle}</div>}
        </div>
        {columns.length > 0 && rows.length > 0 && (
          <button
            onClick={() => downloadCSV(title, subtitle, columns, rows)}
            title="Download as CSV (opens in Excel)"
            style={{ flexShrink:0, width:28, height:28, borderRadius:6, border:`1px solid ${PUR_B}`, background:'#fff', color:PUR, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', padding:0 }}
            onMouseEnter={e=>{e.currentTarget.style.background=PUR;e.currentTarget.style.color='#fff';e.currentTarget.style.borderColor=PUR;}}
            onMouseLeave={e=>{e.currentTarget.style.background='#fff';e.currentTarget.style.color=PUR;e.currentTarget.style.borderColor=PUR_B;}}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
              <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
            </svg>
          </button>
        )}
      </div>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead><tr style={{ background:PUR_L, borderBottom:`1px solid ${PUR_B}` }}>{columns.map((col,i)=>(<th key={i} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600, color:hl.has(i)?PUR:'#4C1D95', whiteSpace:'nowrap', fontSize:11 }}>{col}</th>))}</tr></thead>
          <tbody>{rows.map((row,ri)=>(<tr key={ri} style={{ borderBottom:`1px solid ${PUR_B}`, background:ri%2===0?'transparent':PUR_M }}>{row.map((cell,ci)=>(<td key={ci} style={{ padding:'7px 12px', color:hl.has(ci)?'#1E1B4B':'#5B21B6', fontWeight:hl.has(ci)?500:400 }}>{cell}</td>))}</tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Chart Router ─────────────────────────────────────────────────────────────
function ChartWidget({ spec }) {
  if (!spec?.type) return null;
  switch (spec.type) {
    case 'bar':     return <BarChart spec={spec}/>;
    case 'stacked': return <BarChart spec={{ ...spec, stacked:true }}/>;
    case 'line':    return <LineChart spec={spec}/>;
    case 'area':    return <AreaChart spec={spec}/>;
    case 'pie':     return <PieChart spec={spec}/>;
    case 'donut':   return <PieChart spec={{ ...spec, type:'donut' }}/>;
    case 'table':   return <DataTable spec={spec}/>;
    default:        return <BarChart spec={spec}/>;
  }
}

// ─── Parse [CHART] blocks ─────────────────────────────────────────────────────
function parseContent(raw) {
  if (!raw) return { text:'', charts:[] };
  const charts=[];
  const re=/\[CHART\]([\s\S]*?)\[\/CHART\]/g;
  let m;
  while ((m=re.exec(raw))!==null) { try { charts.push(JSON.parse(m[1].trim())); } catch {} }
  const text=raw.replace(/\[CHART\][\s\S]*?\[\/CHART\]/g,'').trim();
  return { text, charts };
}


// ─── Quick Insights catalog ───────────────────────────────────────────────────
// Each entry defines a one-click deep-dive analysis that runs against whatever
// plans are currently in scope.  Add new entries here to surface more analyses.
const QUICK_INSIGHTS = [
  {
    id:          'otc_flex',
    emoji:       '🛒',
    iconBg:      '#FFF7ED',
    iconBorder:  '#FED7AA',
    title:       'OTC & Flex Card',
    description: 'Allowances, wallet types, carryover rules, purchase channels, and vendor programs — structured side-by-side.',
    tags:        ['Coverage', 'Allowance', 'Wallet type', 'Carryover', 'Channels', 'Vendor'],
    prompt:
`Compare OTC and Flex Card benefits across these plans.

Show in a structured grid:

* Coverage and eligible items
* Allowance amount and frequency
* Wallet/card type and funding method
* Carryover rules and expiry
* Purchase channels (online, retail, catalog)
* Vendor/program name

Also include:

* Key differences summary
* Exact EOC quotes for each data point
* Call out missing information clearly`,
  },
];

// ─── Quick Insight Card ───────────────────────────────────────────────────────
function QuickInsightCard({ insight, scopeCount, anyActive, startupDone, onRun }) {
  const [warn,    setWarn]    = useState(null); // null | 'loading' | 'no_docs' | 'no_scope' | 'too_many'
  const [hovered, setHovered] = useState(false);

  const scopeOk = anyActive && startupDone && scopeCount >= 1 && scopeCount <= 4;

  const handleClick = () => {
    if (!startupDone)  { setWarn('loading');  return; }
    if (!anyActive)    { setWarn('no_docs');   return; }
    if (scopeCount === 0) { setWarn('no_scope'); return; }
    if (scopeCount > 4)   { setWarn('too_many'); return; }
    setWarn(null);
    onRun(insight.prompt);
  };

  return (
    <div style={{ width: 310, flexShrink: 0 }}>
      {/* ── Card ── */}
      <div
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          background: '#fff',
          border: `1.5px solid ${hovered ? PUR : PUR_B}`,
          borderRadius: 14,
          padding: '14px 16px',
          cursor: 'pointer',
          transition: 'box-shadow .18s, border-color .18s, transform .18s',
          boxShadow: hovered ? '0 6px 20px rgba(124,58,237,0.13)' : '0 1px 4px rgba(0,0,0,0.05)',
          transform: hovered ? 'translateY(-2px)' : 'none',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 11, flexShrink: 0,
            background: insight.iconBg, border: `1px solid ${insight.iconBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
          }}>
            {insight.emoji}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E1B4B' }}>{insight.title}</span>
              {startupDone && scopeCount > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                  background: scopeOk ? '#DCFCE7' : '#FFF7ED',
                  color:      scopeOk ? '#166534' : '#92400E',
                  border:     `1px solid ${scopeOk ? '#86EFAC' : '#FCD34D'}`,
                  padding: '2px 8px', borderRadius: 10,
                }}>
                  {scopeCount} plan{scopeCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 3, lineHeight: 1.45 }}>
              {insight.description}
            </div>
          </div>
        </div>

        {/* Tag strip */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 11 }}>
          {insight.tags.map(tag => (
            <span key={tag} style={{
              fontSize: 10, background: PUR_M, color: PUR,
              padding: '2px 8px', borderRadius: 8, border: `1px solid ${PUR_B}`,
            }}>
              {tag}
            </span>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end',
          marginTop: 12, paddingTop: 10, borderTop: `1px solid ${PUR_B}`,
        }}>
          <span style={{
            fontSize: 11.5, fontWeight: 600,
            color: scopeOk ? PUR : '#9CA3AF',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            {!startupDone
              ? 'Loading…'
              : scopeOk
                ? '▶ Run Analysis →'
                : scopeCount === 0
                  ? 'Select 1–4 plans to run'
                  : scopeCount > 4
                    ? `Narrow to 1–4 plans (${scopeCount} in scope)`
                    : 'Select plans using filters above'}
          </span>
        </div>
      </div>

      {/* ── Scope guidance callout (shown below card on click when scope is wrong) ── */}
      {warn && (
        <div style={{
          marginTop: 6, background: '#FFFBEB', border: '1px solid #FCD34D',
          borderRadius: 10, padding: '10px 12px', fontSize: 11.5,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ color: '#92400E', lineHeight: 1.5 }}>
              {warn === 'loading'  && '⏳ Documents are still indexing — please wait a moment, then try again.'}
              {warn === 'no_docs'  && '⚠️ No documents are loaded yet. Please wait for indexing to complete.'}
              {warn === 'no_scope' && '⚠️ No plans in scope. Use the filters above to select 1–4 plans, then click again.'}
              {warn === 'too_many' && `⚠️ ${scopeCount} plans are in scope. This comparison is most focused with 1–4 plans — narrow using the filters above, or run with all ${scopeCount}.`}
            </span>
            <button
              onClick={e => { e.stopPropagation(); setWarn(null); }}
              style={{ background: 'none', border: 'none', color: '#92400E', cursor: 'pointer', fontSize: 14, padding: 0, flexShrink: 0 }}
            >✕</button>
          </div>
          {warn === 'too_many' && (
            <button
              onClick={e => { e.stopPropagation(); setWarn(null); onRun(insight.prompt); }}
              style={{
                marginTop: 8, fontSize: 11.5, fontWeight: 600,
                color: '#fff', background: PUR, border: 'none',
                borderRadius: 7, padding: '5px 14px',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Run with all {scopeCount} plans →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sample questions ─────────────────────────────────────────────────────────
const DOC_PILLS = [
  'What is the out-of-pocket maximum for in-network services?',
  'Does this plan cover dental implants?',
  'What are the exclusions for orthodontic services?',
  'What prior authorization is required for specialist visits?',
  'How is emergency care covered outside the service area?',
  'What are the annual dental maximum benefit limits?',
  'Are there any waiting periods for major dental services?',
  'What cost-sharing applies to oral surgery?',
];

// ─── Conversation persistence ─────────────────────────────────────────────────
const CONV_KEY     = 'hwai_conversations';
const MAX_CONVS    = 50;

function loadConversations() {
  try { return JSON.parse(localStorage.getItem(CONV_KEY) || '[]'); }
  catch { return []; }
}
function saveConversations(convs) {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(convs.slice(0, MAX_CONVS))); }
  catch {}
}
function relativeTime(ts) {
  const diff = Date.now() - ts, mins = Math.floor(diff/60000), h = Math.floor(diff/3600000), d = Math.floor(diff/86400000);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return `${mins}m ago`;
  if (h < 24)     return `${h}h ago`;
  if (d === 1)    return 'Yesterday';
  if (d < 7)      return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(ts).getDay()];
  return new Date(ts).toLocaleDateString();
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({ collapsed, onToggle, activeHistory, conversations, onSelectHistory, onDeleteHistory, onNewChat }) {
  const [hoveredId,  setHoveredId]  = useState(null);
  const [menuOpenId, setMenuOpenId] = useState(null);
  if (collapsed) return (
    <aside style={{ width:44, background:'#fff', display:'flex', flexDirection:'column', alignItems:'center', flexShrink:0, borderRight:'1px solid #E5E7EB' }}>
      <div style={{ padding:'12px 0', borderBottom:'1px solid #E5E7EB', width:'100%', display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
        <img src="https://drlobbystorer1.blob.core.windows.net/images/HWAI_Logo_Full.svg?v=1" alt="HWAI" style={{ height:20, width:20, objectFit:'contain' }} onError={(e)=>{e.target.style.display='none';}}/>
        <button onClick={onToggle} style={{ background:'none', border:'none', cursor:'pointer', color:'#9CA3AF', fontSize:16 }}>›</button>
      </div>
      <div style={{ paddingTop:10 }}>
        <button onClick={onNewChat} style={{ width:28, height:28, borderRadius:6, background:PUR_M, border:`1px solid ${PUR_B}`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, color:PUR }}>+</button>
      </div>
    </aside>
  );
  return (
    <aside style={{ width:220, background:'#fff', display:'flex', flexDirection:'column', flexShrink:0, borderRight:'1px solid #E5E7EB' }}>
      <div style={{ padding:'14px 14px 10px', borderBottom:'1px solid #F3F4F6', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <img src="https://drlobbystorer1.blob.core.windows.net/images/HWAI_Logo_Full.svg?v=1" alt="HealthWorksAI" style={{ height:22, width:'auto' }} onError={(e)=>{e.target.style.display='none';e.target.nextSibling.style.display='block';}}/>
          <span style={{ display:'none', fontWeight:800, fontSize:11, color:'#1F2937' }}>HealthWorksAI</span>
        </div>
        <button onClick={onToggle} style={{ background:'none', border:'none', cursor:'pointer', color:'#9CA3AF', fontSize:16, padding:2 }}>‹</button>
      </div>
      <div style={{ padding:'10px 12px 6px', flexShrink:0 }}>
        <button onClick={onNewChat} style={{ width:'100%', display:'flex', alignItems:'center', gap:7, padding:'7px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:600, background:PUR_M, color:PUR, border:`1px solid ${PUR_B}` }}>
          <span style={{ fontSize:16, fontWeight:300 }}>+</span> New conversation
        </button>
      </div>
      <div style={{ padding:'6px 14px 4px', fontSize:10, fontWeight:700, color:'#9CA3AF', textTransform:'uppercase', letterSpacing:'.08em', flexShrink:0 }}>Recent</div>
      {/* Backdrop — clicking outside any open menu closes it, pure React no native listeners */}
      {menuOpenId && (
        <div onClick={() => setMenuOpenId(null)} style={{ position:'fixed', inset:0, zIndex:98 }}/>
      )}
      <div style={{ flex:1, overflowY:'auto', padding:'2px 8px 8px' }}>
        {conversations.length === 0 && (
          <div style={{ padding:'12px 8px', fontSize:11, color:'#CBD5E1', textAlign:'center' }}>No conversations yet</div>
        )}
        {conversations.map((conv) => {
          const isActive  = activeHistory === conv.id;
          const isHovered = hoveredId === conv.id;
          return (
            <div
              key={conv.id}
              onClick={() => { if (menuOpenId) { setMenuOpenId(null); return; } onSelectHistory(conv.id); }}
              onMouseEnter={() => setHoveredId(conv.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 8px', borderRadius:7, marginBottom:1, cursor:'pointer', background:isActive?PUR_M:isHovered?'#F9FAFB':'transparent', borderLeft:isActive?`2px solid ${PUR}`:'2px solid transparent' }}
            >
              <div style={{ minWidth:0, flex:1 }}>
                <div style={{ fontSize:12, color:isActive?PUR:'#374151', fontWeight:isActive?600:400, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:138 }}>{conv.title}</div>
                <div style={{ fontSize:10, color:'#9CA3AF', marginTop:1 }}>{relativeTime(conv.updatedAt)}</div>
              </div>
              {(isHovered || isActive || menuOpenId === conv.id) && (
                <div style={{ position:'relative', flexShrink:0, zIndex:99 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === conv.id ? null : conv.id); }}
                    style={{ background:'none', border:'none', cursor:'pointer', color:'#9CA3AF', fontSize:15, lineHeight:1, padding:'2px 4px', borderRadius:4, display:'flex', alignItems:'center', justifyContent:'center', letterSpacing:'1px' }}
                    onMouseEnter={e => e.currentTarget.style.color=PUR}
                    onMouseLeave={e => e.currentTarget.style.color='#9CA3AF'}
                  >
                    ···
                  </button>
                  {menuOpenId === conv.id && (
                    <div style={{ position:'absolute', right:0, top:'100%', marginTop:2, background:'#fff', border:'1px solid #E5E7EB', borderRadius:8, boxShadow:'0 4px 12px rgba(0,0,0,0.1)', zIndex:100, minWidth:120, overflow:'hidden' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); onDeleteHistory(conv.id); }}
                        style={{ width:'100%', padding:'8px 12px', background:'none', border:'none', cursor:'pointer', textAlign:'left', fontSize:12, color:'#EF4444', fontFamily:'inherit', display:'flex', alignItems:'center', gap:7 }}
                        onMouseEnter={e => e.currentTarget.style.background='#FEF2F2'}
                        onMouseLeave={e => e.currentTarget.style.background='none'}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding:'8px 14px', borderTop:'1px solid #F3F4F6', fontSize:9, color:'#9CA3AF', flexShrink:0 }}>v1.0.0 · HealthWorksAI</div>
    </aside>
  );
}

// ─── Stats Banner ─────────────────────────────────────────────────────────────
function StatsBanner({ documents, filteredCount, hasFilters, onClearFilters }) {
  const total = documents.filter(d => d.status === 'ready').length;
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 20px', background:PUR_M, borderBottom:`1px solid ${PUR_B}`, flexShrink:0, gap:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ width:7, height:7, borderRadius:'50%', background:total>0?'#10B981':PUR }}/>
          <span style={{ fontSize:11, fontWeight:700, color:PUR }}>
            {hasFilters
              ? `${filteredCount} of ${total} EOC${total!==1?'s':''} in scope`
              : `${total} document${total!==1?'s':''} available`}
          </span>
        </div>
        {!hasFilters && (
          <>
            <div style={{ width:1, height:13, background:PUR_B }}/>
            <span style={{ fontSize:11, fontWeight:700, color:PUR }}>
              {total} EOC{total!==1?'s':''} available
            </span>
          </>
        )}
        {hasFilters && (
          <button
            onClick={onClearFilters}
            style={{ fontSize:10, color:PUR, background:'none', border:`1px solid ${PUR_B}`, borderRadius:10, padding:'1px 8px', cursor:'pointer', fontFamily:'inherit', fontWeight:600 }}
          >
            ✕ Clear filters
          </button>
        )}
      </div>
      <span style={{ fontSize:10, color:PUR, background:PUR_L, padding:'2px 9px', borderRadius:20, fontWeight:600, border:`1px solid ${PUR_B}` }}>
        RAG-powered · citations grounded in source docs
      </span>
    </div>
  );
}

// ─── Chat Message ─────────────────────────────────────────────────────────────
function ChatMsg({ msg, isStreaming }) {
  const isUser = msg.role === 'user';
  const { text, charts } = parseContent(msg.content);
  const hasCharts = charts.length > 0;

  if (isUser) return (
    <div style={{ alignSelf:'flex-end', maxWidth:'80%' }}>
      <div style={{ background:PUR, color:'#fff', padding:'9px 14px', borderRadius:'12px 3px 12px 12px', fontSize:13, lineHeight:1.55 }}>
        {msg.content}
        <div style={{ fontSize:9.5, opacity:0.6, marginTop:3, textAlign:'right' }}>{tstr(msg.ts)}</div>
      </div>
    </div>
  );

  return (
    <div style={{ alignSelf:'flex-start', maxWidth: hasCharts ? '96%' : '88%' }}>
      <div style={{ background:'#fff', border:'1px solid #E2E8F0', padding:'10px 14px', borderRadius:'3px 12px 12px 12px', fontSize:13, lineHeight:1.6, marginBottom:6 }}>
        {msg.loading
          ? <span style={{ display:'flex', alignItems:'center', gap:6, color:'#94A3B8', fontSize:12 }}><Dots/>Searching documents...</span>
          : text ? <div dangerouslySetInnerHTML={{ __html: mdHtml(text) }}/> : null
        }
        {!isStreaming && charts.map((spec,i) => <ChartWidget key={i} spec={spec}/>)}
      </div>
      {!msg.loading && (
        <div style={{ fontSize:9.5, color:'#CBD5E1', marginTop:3 }}>{tstr(msg.ts)}</div>
      )}
    </div>
  );
}

// ─── Multi-select dropdown with staged Apply ──────────────────────────────────
function MultiSelect({ label, options, selected, onChange, width = 148 }) {
  const [open, setOpen]       = useState(false);
  const [pending, setPending] = useState([]);

  const noneApplied = selected.length === 0;

  const openDropdown = () => {
    setPending(selected);
    setOpen(true);
  };
  const closeDropdown = () => setOpen(false); // discard pending on backdrop click

  const toggle = (val) =>
    setPending(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]);

  const apply = () => { onChange(pending); setOpen(false); };
  const clearPending = () => setPending([]);

  const pendingDiffers =
    pending.length !== selected.length || pending.some(v => !selected.includes(v));

  const btnLabel = noneApplied
    ? `All ${label}`
    : selected.length === 1
      ? (selected[0].length > 16 ? selected[0].slice(0, 16) + '…' : selected[0])
      : `${selected.length} selected`;

  return (
    <div style={{ width, flexShrink:0, position:'relative', zIndex: open ? 200 : 1 }}>
      {open && (
        <div onClick={closeDropdown} style={{ position:'fixed', inset:0, zIndex:198 }}/>
      )}
      <div style={{ fontSize:10, fontWeight:700, color:'#9CA3AF', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:4 }}>
        {label}
      </div>
      <button
        onClick={() => open ? closeDropdown() : openDropdown()}
        style={{
          display:'flex', alignItems:'center', gap:4,
          width:'100%', height:30, padding:'0 8px', boxSizing:'border-box',
          border:`1px solid ${noneApplied ? '#D1D5DB' : PUR}`,
          borderRadius:6, background:noneApplied ? '#fff' : PUR_M,
          color:noneApplied ? '#6B7280' : PUR, fontFamily:'inherit',
          fontSize:11.5, fontWeight:noneApplied ? 400 : 600,
          cursor:'pointer', outline:'none',
        }}
      >
        <span style={{ flex:1, textAlign:'left', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {btnLabel}
        </span>
        <svg width="8" height="5" viewBox="0 0 10 6" style={{ flexShrink:0, transform:open ? 'rotate(180deg)' : 'none', transition:'transform .15s' }}>
          <path d="M0 0l5 6 5-6z" fill={noneApplied ? '#9CA3AF' : PUR}/>
        </svg>
      </button>
      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 3px)', left:0, zIndex:199,
          background:'#fff', border:'1px solid #E2E8F0',
          borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.12)',
          minWidth:Math.max(width, 190), maxHeight:280,
          display:'flex', flexDirection:'column',
        }}>
          {/* Header */}
          <div style={{ padding:'6px 10px 5px', borderBottom:'1px solid #F3F4F6', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
            <span style={{ fontSize:10, fontWeight:700, color:'#9CA3AF', textTransform:'uppercase' }}>
              {options.length} option{options.length !== 1 ? 's' : ''}
            </span>
            {pending.length > 0 && (
              <button onClick={clearPending} style={{ fontSize:10, color:PUR, background:'none', border:'none', cursor:'pointer', padding:0, fontFamily:'inherit', fontWeight:600 }}>
                Clear
              </button>
            )}
          </div>
          {/* Options list */}
          <div style={{ overflowY:'auto', flex:1 }}>
            {/* "All" — always first; checked when nothing specific is selected */}
            <label
              style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', cursor:'pointer', fontSize:11.5, lineHeight:1.4, borderBottom:`1px solid #F3F4F6` }}
              onMouseEnter={e => e.currentTarget.style.background = PUR_M}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <input
                type="checkbox"
                checked={pending.length === 0}
                onChange={() => setPending([])}
                style={{ accentColor:PUR, flexShrink:0, cursor:'pointer', width:13, height:13 }}
              />
              <span style={{ fontWeight:700, color: pending.length === 0 ? PUR : '#6B7280' }}>All</span>
            </label>
            {options.length === 0 && (
              <div style={{ padding:'10px 12px', fontSize:11, color:'#9CA3AF' }}>No options</div>
            )}
            {options.map(opt => (
              <label
                key={opt}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 10px', cursor:'pointer', fontSize:11.5, color:'#1F2937', lineHeight:1.4 }}
                onMouseEnter={e => e.currentTarget.style.background = PUR_M}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <input
                  type="checkbox"
                  checked={pending.includes(opt)}
                  onChange={() => toggle(opt)}
                  style={{ accentColor:PUR, flexShrink:0, cursor:'pointer', width:13, height:13 }}
                />
                <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={opt}>{opt}</span>
              </label>
            ))}
          </div>
          {/* Apply footer */}
          <div style={{ padding:'6px 8px', borderTop:'1px solid #F3F4F6', flexShrink:0 }}>
            <button
              onClick={apply}
              disabled={!pendingDiffers}
              style={{
                width:'100%', padding:'5px 0',
                background:pendingDiffers ? PUR : '#E5E7EB',
                color:pendingDiffers ? '#fff' : '#9CA3AF',
                border:'none', borderRadius:5,
                cursor:pendingDiffers ? 'pointer' : 'default',
                fontFamily:'inherit', fontSize:11.5, fontWeight:600,
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function Home() {
  // Sidebar state
  const [collapsed,     setCollapsed]     = useState(false);
  const [activeHistory, setActiveHistory] = useState(null);
  const [integratePC,   setIntegratePC]   = useState(false);

  // Filter state — each is an array of selected values; empty = "All" (no filter)
  const [selSalesRegions, setSelSalesRegions] = useState([]);
  const [selPayors,       setSelPayors]       = useState([]);
  const [selStates,       setSelStates]       = useState([]);
  const [selCounties,     setSelCounties]     = useState([]);
  const [selPlanTypes,    setSelPlanTypes]    = useState([]);
  const [selSnpTypes,     setSelSnpTypes]     = useState([]);
  const [selPlanNames,    setSelPlanNames]    = useState([]);

  // Metadata from CSV — populated on mount
  const [metadata, setMetadata] = useState({ rows: [], filterOptions: {} });

  // Chat state
  const [query,   setQuery]   = useState('');
  const [msgs,    setMsgs]    = useState([]);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState(null);

  // Conversation history (persisted to localStorage)
  // Start with [] on both server and client to avoid hydration mismatch;
  // populate from localStorage after mount via useEffect below.
  const [conversations, setConversations] = useState([]);
  const currentConvIdRef   = useRef(null);  // ID of the conversation in view
  const loadingFromHistory = useRef(false); // guard: don't re-save when restoring

  // Document library state (from our backend)
  const [documents,   setDocuments]   = useState([]);
  const [storageLabel, setStorageLabel] = useState('');
  const [startupDone, setStartupDone] = useState(false);

  const endRef  = useRef(null);
  const textRef = useRef(null);

  // Load metadata CSV on mount
  useEffect(() => {
    fetch('/api/metadata')
      .then(r => r.json())
      .then(d => setMetadata(d))
      .catch(e => console.error('[metadata]', e));
  }, []);

  // Counties cascade from Sales Region + State
  const availableCounties = useMemo(() => {
    let rows = metadata.rows;
    if (selSalesRegions.length > 0) rows = rows.filter(r => selSalesRegions.includes(r.SALES_REGION));
    if (selStates.length       > 0) rows = rows.filter(r => selStates.includes(r.STATE));
    return [...new Set(rows.map(r => r.COUNTY).filter(Boolean))].sort();
  }, [selSalesRegions, selStates, metadata.rows]);

  // Drop counties that no longer exist when states change
  useEffect(() => {
    setSelCounties(prev => prev.filter(c => availableCounties.includes(c)));
  }, [availableCounties]);

  // Plan names cascade from all other active filters
  const availablePlanNames = useMemo(() => {
    let rows = metadata.rows;
    if (selSalesRegions.length > 0) rows = rows.filter(r => selSalesRegions.includes(r.SALES_REGION));
    if (selPayors.length       > 0) rows = rows.filter(r => selPayors.includes(r.PAYOR));
    if (selStates.length       > 0) rows = rows.filter(r => selStates.includes(r.STATE));
    if (selCounties.length     > 0) rows = rows.filter(r => selCounties.includes(r.COUNTY));
    if (selPlanTypes.length    > 0) rows = rows.filter(r => selPlanTypes.includes(r.PLAN_TYPE));
    if (selSnpTypes.length     > 0) rows = rows.filter(r => selSnpTypes.includes(r.SNP_TYPE));
    return [...new Set(rows.map(r => r.PLAN_NAME).filter(Boolean))].sort();
  }, [selSalesRegions, selPayors, selStates, selCounties, selPlanTypes, selSnpTypes, metadata.rows]);

  // Drop plan names that are no longer valid when upstream filters change
  useEffect(() => {
    setSelPlanNames(prev => prev.filter(n => availablePlanNames.includes(n)));
  }, [availablePlanNames]);

  const hasActiveFilters =
    selSalesRegions.length > 0 || selPayors.length > 0 ||
    selStates.length > 0 || selCounties.length > 0 ||
    selPlanTypes.length > 0 || selSnpTypes.length > 0 || selPlanNames.length > 0;

  const clearAllFilters = useCallback(() => {
    setSelSalesRegions([]); setSelPayors([]);
    setSelStates([]); setSelCounties([]);
    setSelPlanTypes([]); setSelSnpTypes([]); setSelPlanNames([]);
  }, []);

  // Unique PDF_NAMEs that match active filters
  const filteredPdfNames = useMemo(() => {
    if (!hasActiveFilters) return null; // null = no filter, use all docs
    let rows = metadata.rows;
    if (selSalesRegions.length > 0) rows = rows.filter(r => selSalesRegions.includes(r.SALES_REGION));
    if (selPayors.length       > 0) rows = rows.filter(r => selPayors.includes(r.PAYOR));
    if (selStates.length       > 0) rows = rows.filter(r => selStates.includes(r.STATE));
    if (selCounties.length     > 0) rows = rows.filter(r => selCounties.includes(r.COUNTY));
    if (selPlanTypes.length    > 0) rows = rows.filter(r => selPlanTypes.includes(r.PLAN_TYPE));
    if (selSnpTypes.length     > 0) rows = rows.filter(r => selSnpTypes.includes(r.SNP_TYPE));
    if (selPlanNames.length    > 0) rows = rows.filter(r => selPlanNames.includes(r.PLAN_NAME));
    return new Set(rows.map(r => r.PDF_NAME));
  }, [hasActiveFilters, selSalesRegions, selPayors, selStates, selCounties, selPlanTypes, selSnpTypes, selPlanNames, metadata.rows]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }); }, [msgs]);

  // ── Load saved conversations from localStorage after mount ──────────────────
  useEffect(() => { setConversations(loadConversations()); }, []);

  // ── Persist conversation to localStorage whenever msgs settle ───────────────
  useEffect(() => {
    if (loadingFromHistory.current) { loadingFromHistory.current = false; return; }
    const stable = msgs.filter(m => !m.loading && m.content);
    if (stable.length === 0) return;
    const firstUser = stable.find(m => m.role === 'user');
    if (!firstUser) return;
    if (!currentConvIdRef.current) currentConvIdRef.current = uid();
    const convId = currentConvIdRef.current;
    const title  = firstUser.content.length > 55
      ? firstUser.content.slice(0, 55) + '…'
      : firstUser.content;
    setConversations(prev => {
      const rest    = prev.filter(c => c.id !== convId);
      const updated = [{ id:convId, title, updatedAt:Date.now(), messages:stable }, ...rest];
      saveConversations(updated);
      return updated;
    });
    setActiveHistory(convId);
  }, [msgs]);

  // ── Auto-index all PDFs on mount ────────────────────────────────────────────
  useEffect(() => { autoIndexAll(); }, []);

  const autoIndexAll = async () => {
    try {
      const res  = await fetch('/api/documents');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStorageLabel(data.label || '');
      const files = data.files || [];
      if (files.length === 0) { setStartupDone(true); return; }
      // Always start as 'indexing' — index-pdf returns from cache instantly when the
      // tree index is already in /tmp (warm instance), and re-parses when /tmp was
      // cleared by a Vercel cold start. Skipping indexOne for "already indexed" files
      // causes "Documents not found" after cold starts because the registry has docIds
      // but the tree indices are gone from /tmp.
      setDocuments(files.map(f => ({
        filename: f.name, docId: null,
        nodeCount: 0,
        status: 'indexing', progress: 'Queued…', error: null,
      })));
      const BATCH = 50;
      for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(f => indexOne(f.name)));
      }
    } catch(err) { console.error('autoIndexAll error:', err); }
    finally { setStartupDone(true); }
  };

  const indexOne = async (filename) => {
    const update = (patch) => setDocuments(prev => prev.map(d => d.filename === filename ? { ...d, ...patch } : d));
    update({ status:'indexing', progress:'Loading…' });
    try {
      const res = await fetch('/api/index-pdf', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ filename }) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        const lines = dec.decode(value, { stream:true }).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.event === 'progress') update({ progress: evt.message });
            else if (evt.event === 'done') update({ docId:evt.docId, nodeCount:evt.nodeCount, status:'ready', progress:'' });
            else if (evt.event === 'error') throw new Error(evt.message);
          } catch(pe) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
        }
      }
    } catch(e) { update({ status:'error', progress:'', error:e.message }); }
  };

  const readyDocs         = documents.filter(d => d.status === 'ready' && d.docId);
  const filteredReadyDocs = filteredPdfNames
    ? readyDocs.filter(d => filteredPdfNames.has(d.filename))
    : readyDocs;
  const activeDocIds = filteredReadyDocs.map(d => d.docId);
  const anyReady     = readyDocs.length > 0;
  const anyActive    = filteredReadyDocs.length > 0;

  // ── Send message ─────────────────────────────────────────────────────────────
  const ask = useCallback(async (text) => {
    const content = (text || query).trim();
    if (!content || busy) return;
    if (!anyReady) { setErr('Documents are still loading, please wait…'); return; }
    if (!anyActive) { setErr('No documents match the active filters. Clear or adjust filters to query.'); return; }
    setQuery('');
    setErr(null);
    const userMsg = { id:uid(), role:'user', content, ts:new Date() };

    // ── Meta-query intercept: answer from frontend state, no API call ─────
    // Questions about which plans/documents are loaded should be answered
    // directly — the RAG pipeline only sees MAX_DOCS_TO_QUERY (5) docs at a
    // time, so it would always give an incomplete list.
    // IMPORTANT: do NOT intercept if the message contains medical/benefit terms —
    // those are real questions that need RAG (e.g. "copayment for the above plans").

    // Expanded benefit vocabulary — if any of these appear, it's a real benefit query, not meta.
    const BENEFIT_TERMS = /copay|copayment|coinsurance|deductible|coverage|covered|benefit|cost|premium|prior auth|authorization|ambulance|dental|vision|hearing|drug|prescription|formulary|specialist|emergency|hospital|physician|service|procedure|out.of.pocket|in.network|out.of.network|fitness|vendor|gym|exclusion|limit|allowance|otc|flex\s*card|flex\s*essentials|over.the.counter|supplement|transport|meal|chiropractic|acupuncture|podiatry|physical therapy|mental health|behavioral|reimburs|maximum|minimum|tier|formulary|chronic|quarter|monthly|annual/i;

    // ── Scope/filter metadata intercept ──────────────────────────────────
    // Catches queries asking about payor/state/plan names currently in scope.
    // These are answered directly from the loaded metadata — zero document
    // retrieval needed. Examples: "mention the payors in scope", "show me
    // the states selected", "in a table, list plan names that are filtered".
    const SCOPE_PATTERNS = /\b(payor|payer|payors|payers|state|states|plan\s*name|plan\s*names|in\s*scope|in\s+scope|selected|filtered)\b/i;
    const SCOPE_REQUEST  = /\b(mention|list|show|display|tell|give|provide|what|which|tabular|table|format|summarize|summary)\b/i;
    if (SCOPE_PATTERNS.test(content) && SCOPE_REQUEST.test(content) && !BENEFIT_TERMS.test(content) && metadata.rows.length > 0) {
      const scopeFilenames = hasActiveFilters
        ? filteredPdfNames
        : new Set(readyDocs.map(d => d.filename));
      const seen = new Set();
      const scopeMeta = metadata.rows.filter(r => {
        if (!scopeFilenames || !scopeFilenames.has(r.PDF_NAME)) return false;
        if (seen.has(r.PDF_NAME)) return false;
        seen.add(r.PDF_NAME);
        return true;
      });
      if (scopeMeta.length > 0) {
        const wantTable = /tabular|table|format/i.test(content);
        const scopeNote = hasActiveFilters
          ? ` (${scopeMeta.length} of ${readyDocs.length} total)`
          : ` (${scopeMeta.length} total)`;
        let reply;
        if (wantTable) {
          const header = '| # | Payor | State | Plan Name | Document |\n|---|-------|-------|-----------|----------|\n';
          const rows = scopeMeta.map((r, i) =>
            `| ${i + 1} | ${r.PAYOR} | ${r.STATE} | ${r.PLAN_NAME} | ${r.PDF_NAME} |`
          ).join('\n');
          reply = `**${scopeMeta.length} plans in scope**${scopeNote}:\n\n${header}${rows}`;
        } else {
          const lines = scopeMeta.map((r, i) =>
            `${i + 1}. **${r.PLAN_NAME}** — ${r.PAYOR} · ${r.STATE} · \`${r.PDF_NAME}\``
          ).join('\n');
          reply = `**${scopeMeta.length} plans in scope**${scopeNote}:\n\n${lines}`;
        }
        setMsgs(p => [...p, userMsg, { id:uid(), role:'assistant', content:reply, loading:false, ts:new Date() }]);
        return;
      }
    }

    // ── Document library meta-query intercept ────────────────────────────
    // Patterns that indicate the user is asking ABOUT the loaded library — not about benefits.
    // IMPORTANT: "name" is only a meta-signal when it's used as a verb at the start of the
    // query ("name the plans", "names of loaded docs"). Mid-sentence uses like
    // "Fitness Vendor Name ... plans" must NOT trigger this intercept.
    const META_PATTERNS = /list.*(plan|doc|file|pdf|loaded|available|analys)|what.*(plan|doc|loaded|available)|which.*(plan|doc|loaded)|show.*(plan|doc|loaded|available)|^names?\s+(of\s+|the\s+|all\s+)?(loaded\s+|available\s+)?(plan|doc|pdf|file)|how many.*(plan|doc)|(plan|doc).*(available|loaded|analys)|tell.*(plan|doc)|all.*(plan|doc).*(loaded|available|analys)/i;
    if (META_PATTERNS.test(content) && !BENEFIT_TERMS.test(content)) {
      const scopeDocs = filteredReadyDocs;
      // Enrich each document with payor/state/plan name from metadata if available
      const metaByFile = Object.fromEntries(metadata.rows.map(r => [r.PDF_NAME, r]));
      const docList = scopeDocs.map((d, i) => {
        const m = metaByFile[d.filename];
        const detail = m
          ? `${m.PLAN_NAME} — ${m.PAYOR} · ${m.STATE}`
          : `${d.nodeCount} sections indexed`;
        return `${i + 1}. **${d.filename}** — ${detail}`;
      }).join('\n');
      const scopeNote = hasActiveFilters ? ` (filtered scope — ${scopeDocs.length} of ${readyDocs.length} total)` : '';
      const reply = `All **${scopeDocs.length} documents**${scopeNote} currently loaded and ready for analysis:\n\n${docList}\n\nYou can ask questions about any of these individually, or compare across multiple plans by naming them in your query.`;
      setMsgs(p => [...p, userMsg, { id:uid(), role:'assistant', content:reply, loading:false, ts:new Date() }]);
      return;
    }

    const lid = uid();
    const loadMsg = { id:lid, role:'assistant', content:'', loading:true, ts:new Date() };
    setMsgs(p => [...p, userMsg, loadMsg]);
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          message: content,
          docIds: activeDocIds,
          history: msgs.filter(m => !m.loading && m.content).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error||'Request failed'); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let assembled = '';
      setMsgs(p => p.map(m => m.id===lid ? { ...m, loading:false, content:'' } : m));
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        const lines = dec.decode(value, { stream:true }).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw==='[DONE]') continue;
          if (raw.startsWith('[SOURCES]')) continue;
          try {
            const delta = JSON.parse(raw).choices?.[0]?.delta?.content||'';
            assembled += delta;
            setMsgs(p => p.map(m => m.id===lid ? { ...m, content:assembled } : m));
          } catch {}
        }
      }
    } catch(e) {
      setMsgs(p => p.map(m => m.id===lid ? { ...m, loading:false, content:`Sorry, error: ${e.message}` } : m));
    } finally { setBusy(false); }
  }, [query, busy, anyReady, anyActive, activeDocIds, filteredReadyDocs, readyDocs, hasActiveFilters]);

  const handleKeyDown = (e) => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };

  const handleSelectHistory = useCallback((convId) => {
    const conv = conversations.find(c => c.id === convId);
    if (!conv) return;
    loadingFromHistory.current  = true;
    currentConvIdRef.current    = convId;
    setActiveHistory(convId);
    setErr(null);
    setMsgs(conv.messages.map(m => ({ ...m, ts: new Date(m.ts) })));
  }, [conversations]);

  const handleNewChat = useCallback(() => {
    currentConvIdRef.current = null;
    setActiveHistory(null);
    setMsgs([]);
    setErr(null);
  }, []);

  const handleDeleteHistory = useCallback((convId) => {
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== convId);
      saveConversations(updated);
      return updated;
    });
    // If the deleted conv was open, start a fresh chat
    if (currentConvIdRef.current === convId) {
      currentConvIdRef.current = null;
      setActiveHistory(null);
      setMsgs([]);
      setErr(null);
    }
  }, []);

  const indexingCount = documents.filter(d => d.status === 'indexing').length;

  return (
    <div style={{ display:'flex', height:'100vh', fontFamily:"'Inter',system-ui,sans-serif", fontSize:14, overflow:'hidden', background:'#F8FAFC' }}>
      <GStyle/>

      {/* ── Sidebar ── */}
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        activeHistory={activeHistory}
        conversations={conversations}
        onSelectHistory={handleSelectHistory}
        onDeleteHistory={handleDeleteHistory}
        onNewChat={handleNewChat}
      />

      {/* ── Main ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* Top bar */}
        <div style={{ padding:'8px 16px', background:'#fff', borderBottom:'1px solid #E2E8F0', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:15 }}>📚</span>
            <span style={{ fontWeight:700, fontSize:13, color:'#0F172A' }}>EOC & Dental Playground</span>
            <span style={{ background:PUR_M, color:PUR, fontSize:10, padding:'2px 8px', borderRadius:20, fontWeight:600, border:`1px solid ${PUR_B}` }}>RAG-powered</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            {/* Indexing indicator */}
            {indexingCount > 0 && (
              <span style={{ fontSize:11, color:PUR, background:PUR_M, padding:'3px 10px', borderRadius:20, border:`1px solid ${PUR_B}` }}>
                ⚙️ Indexing {indexingCount} doc{indexingCount!==1?'s':''}…
              </span>
            )}
            {/* Integrate PC toggle */}
            <div onClick={()=>setIntegratePC(v=>!v)} style={{ display:'flex', alignItems:'center', gap:7, padding:'4px 12px', borderRadius:20, cursor:'pointer', background:integratePC?PUR:PUR_M, border:`1px solid ${integratePC?PUR:PUR_B}` }}>
              <span style={{ fontSize:10 }}>🔗</span>
              <span style={{ fontSize:11, fontWeight:600, color:integratePC?'#fff':PUR }}>Integrate PC</span>
              <span style={{ width:28, height:15, borderRadius:8, display:'inline-flex', alignItems:'center', padding:'0 2px', background:integratePC?'rgba(255,255,255,0.35)':PUR_B }}>
                <span style={{ width:11, height:11, borderRadius:'50%', background:'#fff', display:'block', transition:'transform .2s', transform:integratePC?'translateX(13px)':'translateX(0)' }}/>
              </span>
            </div>
          </div>
        </div>

        {/* Filter bar — driven by eoc_metadata.csv */}
        <div style={{ padding:'10px 20px', background:'#fff', borderBottom:'1px solid #E2E8F0', flexShrink:0, display:'flex', alignItems:'flex-end', gap:8, flexWrap:'nowrap' }}>
          <MultiSelect
            label="Sales Region"
            options={metadata.filterOptions.salesRegions || []}
            selected={selSalesRegions}
            onChange={setSelSalesRegions}
            width={108}
          />
          <MultiSelect
            label="Payor"
            options={metadata.filterOptions.payors || []}
            selected={selPayors}
            onChange={setSelPayors}
            width={108}
          />
          <MultiSelect
            label="State"
            options={metadata.filterOptions.states || []}
            selected={selStates}
            onChange={setSelStates}
            width={115}
          />
          <MultiSelect
            label="County"
            options={availableCounties}
            selected={selCounties}
            onChange={setSelCounties}
            width={120}
          />
          <MultiSelect
            label="Plan Type"
            options={metadata.filterOptions.planTypes || []}
            selected={selPlanTypes}
            onChange={setSelPlanTypes}
            width={115}
          />
          <MultiSelect
            label="SNP Type"
            options={metadata.filterOptions.snpTypes || []}
            selected={selSnpTypes}
            onChange={setSelSnpTypes}
            width={110}
          />
          <MultiSelect
            label="Plan Name"
            options={availablePlanNames}
            selected={selPlanNames}
            onChange={setSelPlanNames}
            width={168}
          />
        </div>

        {/* Stats banner — shows filtered vs total scope */}
        <StatsBanner
          documents={documents}
          filteredCount={filteredReadyDocs.length}
          hasFilters={hasActiveFilters}
          onClearFilters={clearAllFilters}
        />

        {/* Messages / Empty state */}
        <div style={{ flex:1, overflowY:'auto', padding:'20px 24px', display:'flex', flexDirection:'column', gap:10, background:'#F8FAFC' }}>
          {msgs.length === 0 && (
            <div style={{ flex:1, display:'flex', flexDirection:'column', gap:22 }}>

              {/* ── Quick Insights ───────────────────────────────────────────── */}
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
                  <span style={{ fontSize:10.5, fontWeight:700, color:'#94A3B8', textTransform:'uppercase', letterSpacing:'.08em' }}>⚡ Quick Insights</span>
                </div>
                <p style={{ fontSize:11.5, color:'#9CA3AF', margin:'0 0 14px', lineHeight:1.5 }}>
                  One-click deep-dives across your selected plans. Select 1–4 plans using the filters above, then click an insight to run it instantly.
                </p>
                <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                  {QUICK_INSIGHTS.map(insight => (
                    <QuickInsightCard
                      key={insight.id}
                      insight={insight}
                      scopeCount={filteredReadyDocs.length}
                      anyActive={anyActive}
                      startupDone={startupDone}
                      onRun={ask}
                    />
                  ))}
                </div>
              </div>

              {/* ── Divider ─────────────────────────────────────────────────── */}
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ flex:1, height:1, background:'#E2E8F0' }}/>
                <span style={{ fontSize:10, color:'#CBD5E1', fontWeight:600, letterSpacing:'.06em' }}>OR ASK DIRECTLY</span>
                <div style={{ flex:1, height:1, background:'#E2E8F0' }}/>
              </div>

              {/* ── Try asking pills (existing) ──────────────────────────────── */}
              <div>
                <div style={{ fontSize:10.5, fontWeight:700, color:'#94A3B8', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:9 }}>Try asking</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                  {DOC_PILLS.map((p,i) => (
                    <button key={i} onClick={() => ask(p)} disabled={!anyActive} style={{ background:anyActive?PUR_M:'#F1F5F9', border:`1px solid ${anyActive?PUR_B:'#E2E8F0'}`, borderRadius:20, padding:'5px 13px', fontSize:11.5, color:anyActive?PUR:'#94A3B8', cursor:anyActive?'pointer':'not-allowed', fontFamily:'inherit' }}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── No PDFs warning ─────────────────────────────────────────── */}
              {!anyReady && startupDone && documents.length === 0 && (
                <div style={{ padding:'12px 16px', background:'#FFF7ED', border:'1px solid #FED7AA', borderRadius:10, fontSize:12, color:'#92400E' }}>
                  ⚠️ No PDFs found in storage ({storageLabel || 'local /pdfs folder'}). Check your storage configuration and reload.
                </div>
              )}
            </div>
          )}
          {msgs.map(m => (
            <ChatMsg key={m.id} msg={m} isStreaming={busy && msgs[msgs.length-1]?.id === m.id && m.role === 'assistant'}/>
          ))}
          {err && (
            <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:8, padding:'9px 13px', color:'#B91C1C', fontSize:12, display:'flex', gap:8, alignItems:'center' }}>
              <span>⚠️</span>{err}
              <button onClick={()=>setErr(null)} style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'#B91C1C', fontSize:13 }}>✕</button>
            </div>
          )}
          <div ref={endRef}/>
        </div>

        {/* Input bar */}
        <div style={{ padding:'10px 20px', background:'#fff', borderTop:'1px solid #E2E8F0', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8, alignItems:'flex-end', background:'#F8FAFC', borderRadius:12, border:`1.5px solid ${busy?PUR+'88':'#E2E8F0'}`, padding:'8px 10px 8px 14px', transition:'border-color .2s' }}>
            <textarea
              ref={textRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy}
              rows={1}
              placeholder={anyReady ? 'Ask about EOC & Dental documents — exclusions, limits, coverage terms...' : (startupDone ? `No documents found in ${storageLabel || 'storage'} — check configuration and reload…` : 'Indexing documents…')}
              style={{ flex:1, background:'transparent', border:'none', outline:'none', resize:'none', fontSize:13.5, color:'#1E293B', fontFamily:'inherit', lineHeight:1.5, maxHeight:100, overflowY:'auto' }}
              onInput={e => { e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,100)+'px'; }}
            />
            <button
              onClick={() => ask()}
              disabled={busy || !query.trim() || !anyReady}
              style={{ background:(busy||!query.trim()||!anyReady)?'#E2E8F0':PUR, color:(busy||!query.trim()||!anyReady)?'#94A3B8':'#fff', border:'none', borderRadius:8, padding:'7px 18px', cursor:(busy||!query.trim()||!anyReady)?'not-allowed':'pointer', fontWeight:700, fontSize:12.5, flexShrink:0, fontFamily:'inherit' }}
            >
              {busy ? '...' : 'Ask →'}
            </button>
          </div>
          <p style={{ color:'#CBD5E1', fontSize:9.5, marginTop:5, textAlign:'center' }}>
            Attach PDFs, CSVs or images · Enter to send
          </p>
        </div>
      </div>
    </div>
  );
}
