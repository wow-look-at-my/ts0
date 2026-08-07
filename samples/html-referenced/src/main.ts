import { greeting } from "./greet.ts";

const heading = document.getElementById("greeting");
if (heading) heading.textContent = greeting("referenced assets");
