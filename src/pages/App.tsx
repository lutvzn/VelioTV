import { useLocation, useNavigate } from "@solidjs/router";
import { activeElement, View, ElementNode } from "@solidtv/solid";
import { useAnnouncer, useMouse } from "@solidtv/solid/primitives";
import { createEffect, on, onCleanup, type JSX } from "solid-js";
import { PinPrompt } from "../components/PinPrompt";
import { ReminderNotice } from "../components/ReminderNotice";
import { MENU_WIDTH, SideMenu } from "../components/SideMenu";
import { device } from "../device";
import { library } from "../library";
import { SECTIONS } from "../sections";
import { $t } from "../translate";
import { videoFillsScreen, videoWindow } from "../videoWindow";
import { progressSummary } from "./settings/status";

declare module "@solidtv/solid/primitives" {
  interface KeyMap {
    Announcer: string | number | (string | number)[];
    Menu: string | number | (string | number)[];
    Text: string | number | (string | number)[];
    Escape: string | number | (string | number)[];
    Backspace: string | number | (string | number)[];
    ChannelUp: string | number | (string | number)[];
    ChannelDown: string | number | (string | number)[];
    Info: string | number | (string | number)[];
    ChannelList: string | number | (string | number)[];
    Guide: string | number | (string | number)[];
    Tools: string | number | (string | number)[];
  }
}

declare global {
  interface Window {
    APP: ElementNode;
  }
}

// The background's hole for the video window; an empty hole when there's none.
const backgroundHole = () => {
  const video = videoWindow();
  if (!video) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: video.x, y: video.y, w: video.width, h: video.height };
};

// What the menu says while a source imports.
const importStatus = () => {
  const running = library.importing();
  if (!running?.source) return undefined;
  return $t("menu.updatingProgress", {
    name: running.source.name,
    progress: progressSummary(running.progress),
  });
};

const closeApp = () => {
  device.then(d => d.closeApp()).catch(error => console.error("Couldn't close the app:", error));
  return true;
};

// The app's frame: the side menu, and the current section to its right.
// Right moves from the menu into the section; Left or Back moves back out.
// Back on the menu leaves the app. While video fills the screen, the menu
// hides and Left and Back are left to the page.
/**
 * The top of the tree a node is in: the app's, unless it has been taken
 * out. A node taken out may keep its parent, which no longer has it.
 */
const topOf = (node: ElementNode) => {
  let at = node;
  for (let parent = at.parent; parent; parent = at.parent) {
    if (!parent.children.includes(at)) return at;
    at = parent;
  }
  return at;
};

const App = (props: { children?: JSX.Element }) => {
  useMouse();
  const navigate = useNavigate();
  const location = useLocation();
  const announcer = useAnnouncer();
  announcer.debug = false;
  announcer.enabled = false;

  const startsInSection = SECTIONS.some(section => section.path === location.pathname);
  let menu: ElementNode | undefined;
  let content: ElementNode | undefined;

  // The menu is hidden while video fills the screen, and on the full-screen
  // pages even before their video shows.
  const menuHidden = () =>
    videoFillsScreen() || location.pathname === "/watch" || location.pathname === "/play";
  const focusMenu = () => {
    if (menuHidden()) return false;
    menu?.setFocus();
    return true;
  };
  const focusContent = () => {
    content?.setFocus();
    return true;
  };

  // A page that goes while it has the keys, such as when another page
  // opens it, takes them with it; they come back to the menu. Pages that
  // take the keys keep them, as full-screen ones (with no menu) do.
  let check: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => location.pathname,
      () => {
        clearTimeout(check);
        check = setTimeout(() => {
          const active = activeElement();
          if (active && menu && topOf(active) === topOf(menu)) return;
          focusMenu();
        });
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(check));

  return (
    <View ref={window.APP} onAnnouncer={() => (announcer.enabled = !announcer.enabled)}>
      <View color={0x071423ff} shader={["holePunch", backgroundHole()]} />
      <View
        ref={element => (content = element)}
        x={MENU_WIDTH}
        width={1920 - MENU_WIDTH}
        height={1080}
        // To the page's first node, which passes it on to what should have it.
        forwardFocus={0}
        onLeft={focusMenu}
        onBack={focusMenu}
      >
        {props.children}
      </View>
      <SideMenu
        ref={element => (menu = element)}
        hidden={menuHidden()}
        // Only when the app opens on a section. Other pages, such as full
        // screen and developer pages, take focus themselves; and it's read
        // once, since setting it later would take the focus from a page.
        autofocus={startsInSection}
        sections={SECTIONS}
        currentPath={location.pathname}
        onSelect={path => navigate(path, { replace: true })}
        status={importStatus()}
        onRight={focusContent}
        onBack={closeApp}
      />
      <ReminderNotice />
      <PinPrompt />
    </View>
  );
};

export default App;
