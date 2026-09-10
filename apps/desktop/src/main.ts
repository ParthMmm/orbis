import { app, BrowserWindow } from "electron";
import path from "node:path";

function createWindow() {
	const window = new BrowserWindow({
		width: 1100,
		height: 760,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
	} else {
		void window.loadFile(
			path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
		);
	}
}
void app.whenReady().then(() => {
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
