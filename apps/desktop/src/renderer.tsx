import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
	<StrictMode>
		<main>
			<h1>Sets</h1>
			<p>Your set library will live here.</p>
		</main>
	</StrictMode>
);
