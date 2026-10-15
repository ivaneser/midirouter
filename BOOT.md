# BOOT — plug & play for Raspberry Pi

A ready-made workflow: "insert the card → it works". No commands are needed except **one** run of `bootstrap.sh` over SSH the first time.

## What you need at the start
1. A **Raspberry Pi OS (64-bit, Bookworm)** image — flash it with *Raspberry Pi Imager*.
2. In Imager (Advanced options / ⚙) enable:
   - **SSH** — Remote SSH access enabled
   - Wi-Fi — can be left empty; bootstrap itself configures the `master` network
3. Insert the card into the Pi and power it on.

## First run (once)
Log in over SSH (or via HDMI + keyboard):
```bash
ssh pi@<ip>                 # default password: raspberry
sudo bash ~/myprojects/midirouter/bootstrap.sh   # if you have copied the repository
# or, if there is no repository yet:
cd /tmp && curl -fsSL https://raw.githubusercontent.com/ivaneser/midirouter/main/bootstrap.sh -o bootstrap.sh && sudo bash bootstrap.sh
```

The script will:
- find the `master` Wi-Fi network and connect to it;
- install Node.js, ALSA, git;
- add the user `pi` to the `audio` group;
- apply the UMP fix for ALSA (`enable_ump=0`) — otherwise the ports are not visible;
- clone/update the repository and run `npm install`;
- enable autostart of `midirouter.service`;
- disable the old standalone `metronome.service`; the worker controls the audio metronome;
- **reboot the Pi** (so that the UMP fix takes effect).

After the reboot the server starts automatically. Open in a browser:
```
http://<ip-pi>:3000
```

## Settings
All parameters are changed with environment variables before launch:
```bash
MIDIR_USER=pi MIDIR_REPO=/home/pi/myprojects/midirouter sudo bash bootstrap.sh
```
- `WIFI_SSID` / `WIFI_PASS` — Wi-Fi name and password (inside the script).

## If something did not start
```bash
sudo journalctl -u midirouter.service -n 50     # server logs
sudo journalctl -u midirouter.service -n 100    # server and audio-metronome logs
aconnect -i                                      # are the MIDI ports visible?
aplay -L | grep -i headphone                     # is the headphone output found?
lsmod | grep snd                                 # snd_seq with enable_ump=0
systemctl status midirouter.service              # service status
```

## Rollback / removing autostart
```bash
sudo systemctl disable --now midirouter.service
sudo rm /etc/systemd/system/midirouter.service
