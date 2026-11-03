import { useLocation, useNavigate } from "@solidjs/router";
import { View, ElementNode } from "@solidtv/solid";
import { useAnnouncer, useMouse } from "@solidtv/solid/primitives";
import type { JSX } from "solid-js";
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
const App = (props: { children?: JSX.Element }) => {
  useMouse();
  const navigate = useNavigate();
  const location = useLocation();
  const announcer = useAnnouncer();
  announcer.debug = false;
  announcer.enabled = false;

  let menu: ElementNode | undefined;
  let content: ElementNode | undefined;

  const focusMenu = () => {
    // The menu is hidden while video fills the screen.
    if (videoFillsScreen()) return false;
    menu?.setFocus();
    return true;
  };
  const focusContent = () => {
    content?.setFocus();
    return true;
  };

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
        hidden={videoFillsScreen()}
        // Pages outside the menu, such as developer pages, take focus themselves.
        autofocus={SECTIONS.some(section => section.path === location.pathname)}
        sections={SECTIONS}
        currentPath={location.pathname}
        onSelect={path => navigate(path, { replace: true })}
        status={importStatus()}
        onRight={focusContent}
        onBack={closeApp}
      />
    </View>
  );
};

export default App;
