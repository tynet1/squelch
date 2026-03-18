#!/usr/bin/env bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${GREEN}"
echo "╔══════════════════════════════════╗"
echo "║         Squelch  Install         ║"
echo "╚══════════════════════════════════╝"
echo -e "${NC}"

# Must be run on Debian/Ubuntu
if [ ! -f /etc/debian_version ]; then
    echo -e "${RED}Error: This script requires Debian/Ubuntu.${NC}"
    exit 1
fi

# ── System dependencies ───────────────────────────────────────────────────────
echo -e "${YELLOW}[1/6] Installing system dependencies...${NC}"
sudo apt-get update -qq
sudo apt-get install -y \
    gnuradio \
    gnuradio-dev \
    gr-osmosdr \
    rtl-sdr \
    librtlsdr-dev \
    ffmpeg \
    python3-pip \
    python3-venv \
    python3-numpy \
    python3-requests \
    git \
    cmake \
    build-essential \
    pkg-config \
    libboost-all-dev \
    libcppunit-dev \
    swig \
    doxygen

# ── RTL-SDR udev rules (allow non-root access) ───────────────────────────────
echo -e "${YELLOW}[2/6] Configuring RTL-SDR udev rules...${NC}"
sudo tee /etc/udev/rules.d/20-rtlsdr.rules > /dev/null <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666", SYMLINK+="rtl_sdr"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666", SYMLINK+="rtl_sdr"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2840", GROUP="plugdev", MODE="0666", SYMLINK+="rtl_sdr"
EOF
sudo udevadm control --reload-rules
sudo usermod -a -G plugdev "$USER"

# Blacklist kernel DVB drivers that fight with RTL-SDR
if ! grep -q "blacklist dvb_usb_rtl28xxu" /etc/modprobe.d/blacklist-rtlsdr.conf 2>/dev/null; then
    sudo tee /etc/modprobe.d/blacklist-rtlsdr.conf > /dev/null <<'EOF'
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
EOF
fi

# ── Clone and build OP25 (boatbod fork) ──────────────────────────────────────
echo -e "${YELLOW}[3/6] Cloning OP25 (boatbod fork)...${NC}"
OP25_DIR="$SCRIPT_DIR/op25"
if [ ! -d "$OP25_DIR" ]; then
    git clone https://github.com/boatbod/op25.git "$OP25_DIR"
else
    echo "  OP25 directory exists, pulling latest..."
    git -C "$OP25_DIR" pull
fi

echo -e "${YELLOW}[4/6] Building and installing OP25 (this takes a few minutes)...${NC}"
cd "$OP25_DIR"
sudo ./install.sh
cd "$SCRIPT_DIR"

# ── Python virtual environment for web server ─────────────────────────────────
echo -e "${YELLOW}[5/6] Setting up Python environment for web server...${NC}"
python3 -m venv "$SCRIPT_DIR/venv"
"$SCRIPT_DIR/venv/bin/pip" install -q --upgrade pip
"$SCRIPT_DIR/venv/bin/pip" install -q -r "$SCRIPT_DIR/server/requirements.txt"

# ── Config files ──────────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/config/trunk.tsv" ]; then
    cp "$SCRIPT_DIR/config/trunk.tsv.example" "$SCRIPT_DIR/config/trunk.tsv"
fi

# ── Systemd services ──────────────────────────────────────────────────────────
echo -e "${YELLOW}[6/6] Installing systemd services...${NC}"
CURRENT_USER=$(whoami)
OP25_APP="$OP25_DIR/op25/gr-op25-headless/apps"

sudo tee /etc/systemd/system/op25.service > /dev/null <<EOF
[Unit]
Description=Squelch — OP25 P25 Decoder
After=network.target
Wants=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$SCRIPT_DIR/config
ExecStart=/usr/bin/python3 $OP25_APP/rx.py \\
    --nocursor -q -d 0 -N 0 -S 1000000 \\
    --phase2-tdma -T trunk.tsv \\
    -V -U -w -W 0.0.0.0
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/op25-web.service > /dev/null <<EOF
[Unit]
Description=Squelch — Web Remote UI
After=network.target op25.service
Wants=op25.service

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 8888
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable op25.service op25-web.service

# ── Sudoers rule (allow web UI to restart services without password) ───────────
SUDOERS_FILE="/etc/sudoers.d/op25-web"
sudo tee "$SUDOERS_FILE" > /dev/null <<EOF
# Allow op25-web service to restart OP25 services via the web UI
$CURRENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart op25
$CURRENT_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart op25-web
EOF
sudo chmod 440 "$SUDOERS_FILE"
# Validate the sudoers file before leaving it in place
if ! sudo visudo -c -f "$SUDOERS_FILE" 2>/dev/null; then
    echo -e "${RED}Warning: sudoers file failed validation — removing it.${NC}"
    sudo rm -f "$SUDOERS_FILE"
fi

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║            Squelch — Install Complete!               ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  NEXT STEPS:                                         ║"
echo "║  1. Edit config/trunk.tsv with your P25 system info  ║"
echo "║     (or use the gear icon in the web UI)             ║"
echo "║  2. Reboot or re-login for udev group to take effect ║"
echo "║  3. sudo systemctl start op25 op25-web               ║"
echo "║  4. Access at http://<this-machine-ip>:8888          ║"
echo "║     or via Tailscale at http://<tailscale-ip>:8888   ║"
echo "║                                                      ║"
echo "║  LOGS:                                               ║"
echo "║    sudo journalctl -u op25 -f                        ║"
echo "║    sudo journalctl -u op25-web -f                    ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
