import { AbsoluteFill, Composition, interpolate, useCurrentFrame } from 'remotion';

const ink = '#17211f';
const muted = '#66736e';
const green = '#baf36a';

function Box({ x, y, width, title, detail, active }: { x: number; y: number; width: number; title: string; detail: string; active?: boolean }) {
  return <div style={{ position: 'absolute', left: x, top: y, width, height: 118, borderRadius: 20, padding: '23px 25px', boxSizing: 'border-box', background: active ? ink : '#fff', color: active ? '#fff' : ink, boxShadow: '0 12px 40px #17211f12' }}>
    <div style={{ fontSize: 25, fontWeight: 700 }}>{title}</div>
    <div style={{ marginTop: 10, fontSize: 17, color: active ? '#c3d1cc' : muted }}>{detail}</div>
  </div>;
}

export const Explainer = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [12, 105], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const opacity = (start: number) => interpolate(frame, [start, start + 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ background: '#f3f3ec', color: ink, fontFamily: 'Arial, sans-serif' }}>
    <div style={{ position: 'absolute', left: 88, top: 58, fontSize: 16, letterSpacing: 3, fontWeight: 700, color: muted }}>AGENT INTEROP RUNTIME</div>
    <div style={{ position: 'absolute', left: 88, top: 106, width: 800, fontSize: 48, lineHeight: 1.1, fontWeight: 700 }}>One clear view of work across your coding agents.</div>
    <div style={{ position: 'absolute', left: 88, top: 235, width: 780, height: 2, background: '#d6ddd5' }} />
    <div style={{ opacity: opacity(8) }}><Box x={90} y={300} width={300} title="Your MCP client" detail="Ask one agent to help another" /></div>
    <div style={{ opacity: opacity(28) }}><Box x={488} y={300} width={310} title="Local coordinator" detail="Keeps each session distinct" active /></div>
    <div style={{ opacity: opacity(48) }}><Box x={895} y={242} width={292} title="Freebuff" detail="Native session" /></div>
    <div style={{ opacity: opacity(63) }}><Box x={895} y={390} width={292} title="OpenCode" detail="Native session" /></div>
    <div style={{ position: 'absolute', left: 390, top: 354, width: `${progress * 98}px`, height: 3, background: green }} />
    <div style={{ position: 'absolute', left: 798, top: 354, width: `${progress * 96}px`, height: 3, background: green }} />
    <div style={{ opacity: opacity(83), position: 'absolute', left: 90, top: 530, width: 1100, height: 100, borderRadius: 20, padding: 25, boxSizing: 'border-box', background: '#e4ebdf' }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>A message receipt tells you what the provider accepted.</div>
      <div style={{ marginTop: 9, fontSize: 18, color: muted }}>The runtime reports completion only after it can observe completion.</div>
    </div>
    <div style={{ position: 'absolute', left: 90, bottom: 38, fontSize: 15, color: muted }}>Illustration. Provider screens and live work are not shown.</div>
  </AbsoluteFill>;
};

export const ExplainerComposition = () => <Composition id="AgentInteropExplainer" component={Explainer} durationInFrames={150} fps={30} width={1280} height={720} />;

export const Stats = () => <AbsoluteFill style={{ background: '#f3f3ec', color: ink, fontFamily: 'Arial, sans-serif', padding: 72, boxSizing: 'border-box' }}>
  <div style={{ fontSize: 15, letterSpacing: 3, fontWeight: 700, color: muted }}>CHECKED PROJECT FACTS</div>
  <div style={{ marginTop: 20, fontSize: 46, fontWeight: 700 }}>What the current checks show</div>
  <div style={{ display: 'flex', gap: 20, marginTop: 58 }}>
    {[["125", "automated tests passing"], ["3", "offline handoff tasks"], ["0", "duplicate sends observed"], ["12", "OS and Node combinations"]].map(([value, label]) => <div key={value + label} style={{ width: 265, height: 185, borderRadius: 20, padding: 26, boxSizing: 'border-box', background: '#fff', boxShadow: '0 12px 40px #17211f12' }}>
      <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: -3 }}>{value}</div>
      <div style={{ marginTop: 15, fontSize: 18, color: muted }}>{label}</div>
    </div>)}
  </div>
  <div style={{ position: 'absolute', bottom: 60, left: 72, width: 1110, fontSize: 19, color: muted }}>The handoff tasks use simulated providers. Zero duplicate sends applies only to those runs. This is not live provider performance data.</div>
</AbsoluteFill>;

export const StatsComposition = () => <Composition id="CheckedProjectFacts" component={Stats} durationInFrames={1} fps={1} width={1280} height={720} />;
