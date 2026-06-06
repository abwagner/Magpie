import { StateProvider } from "./state/StateProvider.js";
import { Shell } from "./shell/Shell.js";

export default function App() {
  return (
    <StateProvider>
      <Shell />
    </StateProvider>
  );
}
