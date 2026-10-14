-- Station tablets report how they're running (Neal, Oct 14: "can you tell when the tablets are set up?"):
-- whether the camera is on, and whether the page is open as the installed full-screen app or in a plain browser tab.
-- Settings › Station tablets shows it next to "last seen".
ALTER TABLE plan_station_devices ADD COLUMN client_json TEXT;
