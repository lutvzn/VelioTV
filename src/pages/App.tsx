import { useLocation, useNavigate } from "@solidjs/router";
import { View, ElementNode } from "@solidtv/solid";
import { useAnnouncer, useMouse } from "@solidtv/solid/primitives";
import type { JSX } from "solid-js";
import { MENU_WIDTH, SideMenu } from "../components/SideMenu";
import { device } from "../device";
import { SECTIONS } from "../sections";

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

const closeApp = () => {
  device.then(d => d.closeApp()).catch(error => console.error("Couldn't close the app:", error));
  return true;
};

// The app's frame: the side menu, and the current section to its right.
// Right moves from the menu into the section; Left or Back moves back out.
// Back on the menu leaves the app.
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
    menu?.setFocus();
    return true;
  };
  const focusContent = () => {
    content?.setFocus();
    return true;
  };

  return (
    <View ref={window.APP} onAnnouncer={() => (announcer.enabled = !announcer.enabled)}>
      <View color={0x071423ff} />
      <View
        ref={element => (content = element)}
        x={MENU_WIDTH}
        width={1920 - MENU_WIDTH}
        height={1080}
        onLeft={focusMenu}
        onBack={focusMenu}
      >
        {props.children}
      </View>
      <SideMenu
        ref={element => (menu = element)}
        sections={SECTIONS}
        currentPath={location.pathname}
        onSelect={path => navigate(path, { replace: true })}
        onRight={focusContent}
        onBack={closeApp}
      />
    </View>
  );
};

export default App;
