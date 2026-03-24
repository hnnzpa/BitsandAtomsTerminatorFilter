import cv2
import mediapipe as mp
import time
import sys
import datetime
import os
import warnings
import asyncio
import websockets
import threading

# --- SILENCIAR ADVERTENCIAS MOLESTAS ---
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 
os.environ['GLOG_minloglevel'] = '2'
warnings.filterwarnings("ignore", category=UserWarning, module='google.protobuf')

def log_mensaje(mensaje):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {mensaje}")

log_mensaje("=== INICIANDO SCRIPT DE GESTOS (WEBSOCKETS) ===")

# --- SERVIDOR WEBSOCKET INVISIBLE ---
CLIENTS = set()
loop = asyncio.new_event_loop()

async def ws_handler(websocket):
    CLIENTS.add(websocket)
    log_mensaje("🟢 Navegador web (Admira) conectado al sistema de gestos.")
    try:
        await websocket.wait_closed()
    finally:
        CLIENTS.remove(websocket)
        log_mensaje("🔴 Navegador web desconectado.")

def start_ws_server(loop):
    asyncio.set_event_loop(loop)
    start_server = websockets.serve(ws_handler, "localhost", 8765)
    loop.run_until_complete(start_server)
    loop.run_forever()

# Lanzar el servidor en un hilo paralelo para no interrumpir la cámara
ws_thread = threading.Thread(target=start_ws_server, args=(loop,), daemon=True)
ws_thread.start()

async def send_trigger():
    if CLIENTS:
        websockets.broadcast(CLIENTS, "TRIGGER_PHOTO")

def disparar_foto_web():
    asyncio.run_coroutine_threadsafe(send_trigger(), loop)

# --- CONFIGURACIÓN MEDIAPIPE ---
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=1,
    min_detection_confidence=0.7,
    min_tracking_confidence=0.7
)

estado_gesto = "IDLE"  
tiempo_palma_abierta = 0
cooldown_hasta = 0

def contar_dedos_levantados(hand_landmarks):
    dedos = 0
    if abs(hand_landmarks.landmark[4].x - hand_landmarks.landmark[2].x) > 0.05:
        dedos += 1
    puntas, nudillos = [8, 12, 16, 20], [6, 10, 14, 18]
    for p, n in zip(puntas, nudillos):
        if hand_landmarks.landmark[p].y < hand_landmarks.landmark[n].y:
            dedos += 1
    return dedos

# --- INICIALIZAR CÁMARA ---
NUMERO_CAMARA = 1 
cap = cv2.VideoCapture(NUMERO_CAMARA) 

if not cap.isOpened():
    log_mensaje(f"ERROR CRÍTICO: No se pudo abrir la cámara {NUMERO_CAMARA}.")
    sys.exit(1)

log_mensaje(f"Cámara {NUMERO_CAMARA} conectada. Escaneando gestos...")
log_mensaje("⚡ SISTEMA BLINDADO: Ya NO hace falta hacer click en el navegador para que funcione.")

while cap.isOpened():
    success, frame = cap.read()
    if not success: 
        break

    frame = cv2.flip(frame, 1)
    results = hands.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    now = time.time()

    if results.multi_hand_landmarks and now >= cooldown_hasta:
        for hand_landmarks in results.multi_hand_landmarks:
            num_dedos = contar_dedos_levantados(hand_landmarks)
            
            if estado_gesto == "IDLE":
                if num_dedos >= 4:
                    estado_gesto = "PALM_OPEN"
                    tiempo_palma_abierta = now
                    log_mensaje("Palma detectada. Esperando cierre...")

            elif estado_gesto == "PALM_OPEN":
                if num_dedos <= 1 and (now - tiempo_palma_abierta) > 0.4:
                    log_mensaje("¡PUÑO DETECTADO! Enviando señal remota a Admira...")
                    
                    disparar_foto_web()
                    
                    cooldown_hasta = now + 10 
                    estado_gesto = "IDLE"
    else:
        if estado_gesto == "PALM_OPEN": estado_gesto = "IDLE"

cap.release()