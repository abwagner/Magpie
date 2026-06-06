import { Panel } from "../components/ui/Panel.js";

export interface ComingSoonPanelProps {
  label: string;
  phase: number;
}

export function ComingSoonPanel({ label, phase }: ComingSoonPanelProps) {
  return (
    <Panel title={label} actions={["kebab"]}>
      <div
        style={{
          padding: 24,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 12,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        <span style={{ color: "var(--text-2)", fontWeight: 600 }}>{label}</span>
        <span className="dim2">Phase {phase}</span>
      </div>
    </Panel>
  );
}
