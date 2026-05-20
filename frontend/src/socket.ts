import { io, Socket } from "socket.io-client";

// Socket.IO는 CRA 프록시를 거치지 않고 Flask에 직접 연결
// window.location.hostname 사용 → 데스크탑(localhost)·모바일(192.168.x.x) 모두 동작
const SOCKET_URL = `http://${window.location.hostname}:5002`;

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ["polling", "websocket"],  // polling 먼저 → 안정적으로 연결 후 WS 업그레이드
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
  }
  return socket;
}

export function emit(event: string, data?: unknown) {
  getSocket().emit(event, data);
}
