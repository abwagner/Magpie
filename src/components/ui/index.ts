// Phase-0 primitive barrel. Import from here:
//   import { Panel, Modal, Drawer, Icon, Kbd, EnvPill, TypedConfirmation, CommandPalette } from "../components/ui";

export { Icon, type IconName, type IconProps } from "./Icon.js";
export { Kbd, type KbdProps } from "./Kbd.js";
export { Panel, type PanelProps } from "./Panel.js";
export { Modal, type ModalProps } from "./Modal.js";
export { Drawer, type DrawerProps } from "./Drawer.js";
export {
  TypedConfirmation,
  isArmed,
  type TypedConfirmationProps,
  type SafetyWord,
} from "./TypedConfirmation.js";
export { EnvPill, type EnvPillProps, type AppEnv, type TradingMode } from "./EnvPill.js";
export { CommandPalette, type CommandPaletteProps, type CommandItem } from "./CommandPalette.js";
