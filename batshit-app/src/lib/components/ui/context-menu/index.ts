import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
import Content from "./context-menu-content.svelte";
import Item from "./context-menu-item.svelte";
import Label from "./context-menu-label.svelte";
import Separator from "./context-menu-separator.svelte";
import Trigger from "./context-menu-trigger.svelte";

const Root = ContextMenuPrimitive.Root;

export {
	Content,
	Item,
	Label,
	Root as ContextMenu,
	Separator,
	Trigger,
	Content as ContextMenuContent,
	Item as ContextMenuItem,
	Label as ContextMenuLabel,
	Root,
	Separator as ContextMenuSeparator,
	Trigger as ContextMenuTrigger
};
