import { createRenderer, Config as LightningConfig, loadFonts } from "@solidtv/solid";
import { Route } from "@solidjs/router";
import { useFocusManager } from "@solidtv/solid/primitives";
import { HashRouter } from "@solidtv/solid/primitives/router";
import type { RendererMain } from "@solidtv/renderer";
import App from "./pages/App";
import HelloWorld from "./pages/HelloWorld";
import TextPage from "./pages/Text";
import NotFound from "./pages/NotFound";
import fonts from "./fonts";
import { merge } from "lodash-es";
import { config } from "./device";
import {
  Rounded,
  RoundedWithShadow,
  RoundedWithBorder,
  RoundedWithBorderAndShadow,
  RadialGradient,
  LinearGradient,
  HolePunch,
} from "@solidtv/renderer/shaders";

merge(LightningConfig, config.lightning);

const { render, renderer } = createRenderer();

// Shaders are WebGL-only; the DOM renderer is never enabled here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const shaders = renderer as RendererMain;
shaders.registerShaderType("rounded", Rounded);
shaders.registerShaderType("roundedWithBorder", RoundedWithBorder);
shaders.registerShaderType("roundedWithShadow", RoundedWithShadow);
shaders.registerShaderType("roundedWithBorderWithShadow", RoundedWithBorderAndShadow);
shaders.registerShaderType("radialGradient", RadialGradient);
shaders.registerShaderType("linearGradient", LinearGradient);
shaders.registerShaderType("holePunch", HolePunch);

loadFonts(fonts).catch(error => console.error("Fonts failed to load:", error));
render(() => {
  useFocusManager(config.keys);
  return (
    <HashRouter root={App}>
      <Route path="/" component={HelloWorld} />
      <Route path="/text" component={TextPage} />
      <Route path="/*all" component={NotFound} />
    </HashRouter>
  );
});
