import { Panel } from "../components/ui/Panel.js";
import ChainPicker from "../components/ChainPicker.js";

export function ChainPanel() {
  return (
    <Panel title="Option Chain" actions={["filter", "kebab"]}>
      <div style={{ padding: 8, height: "100%", overflow: "auto" }}>
        <ChainPicker spotPrice={100} />
      </div>
    </Panel>
  );
}
