// npx tsc --watch
import { seed_in, solve_btn, stop_btn } from "./ui/dom.js";
import { init_inputs } from "./ui/inputs.js";
import { init_url } from "./ui/url.js";
import { init_map } from "./ui/map_ui.js";
import { init_evaluator } from "./ui/evaluator.js";
import { start, stop } from "./ui/run.js";
init_inputs();
init_url();
init_map();
init_evaluator();
solve_btn.addEventListener("click", () => void start());
stop_btn.addEventListener("click", stop);
seed_in.addEventListener("keydown", (e) => {
    if (e.key === "Enter")
        void start();
});
//# sourceMappingURL=main.js.map