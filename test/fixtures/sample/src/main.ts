import chalk from "chalk";
import { greet } from "./lib/index.js";

export function run(name: string) {
  return chalk.green(greet(name));
}

class App {
  start() {
    return run("world");
  }
}
new App().start();
