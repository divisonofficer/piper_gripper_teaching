/**
 * Piper 로봇 3D URDF 뷰어
 * - /api/urdf/piper.urdf 로드 (mesh 경로 자동 교체됨)
 * - jointsData.teach 에서 currentTime 기준으로 보간하여 관절 각도 적용
 * - Three.js + urdf-loader
 */

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";
// @ts-ignore  — urdf-loader 에는 완전한 TS 타입이 없음
import URDFLoader from "urdf-loader";
import type { JointSample } from "../types";

interface Props {
  samples: JointSample[];   // teach joint samples
  currentTime: number;      // seconds from episode start (video playback time)
}

/** samples에서 currentTime에 가장 가까운 샘플의 인덱스 */
function findNearestIdx(samples: JointSample[], t: number): number {
  if (samples.length === 0) return 0;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(samples[lo - 1].t - t) < Math.abs(samples[lo].t - t)) lo--;
  return lo;
}


function applyJoints(robot: any, samples: JointSample[], currentTime: number) {
  if (!robot || samples.length === 0) return;
  const idx = findNearestIdx(samples, currentTime);
  const s = samples[idx];
  robot.setJointValues({
    joint1: s.q[0],
    joint2: s.q[1],
    joint3: s.q[2],
    joint4: s.q[3],
    joint5: s.q[4],
    joint6: s.q[5],
    joint7:  s.gripper / 2,
    joint8: -s.gripper / 2,
  });
}

function frameRobot(robot: any, camera: THREE.PerspectiveCamera, pivot: THREE.Object3D) {
  if (!robot) return;
  robot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(robot);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  // Aim slightly above the raw mesh center so the arm sits visually centered
  // in wide dashboard panels instead of sinking to the bottom edge.
  const target = center.clone();
  target.y += size.y * 0.08;
  pivot.position.copy(target);

  const radius = Math.max(size.length() * 0.5, 0.35);
  const distance = Math.max(radius * 2.15, 0.75);
  camera.position.copy(target.clone().add(new THREE.Vector3(distance * 0.72, distance * 0.56, distance * 0.86)));
  camera.near = Math.max(distance / 100, 0.001);
  camera.far = Math.max(distance * 10, 10);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

export default function PiperRobotViewer({ samples, currentTime }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const robotRef = useRef<any>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rafRef = useRef<number | null>(null);
  // Keep latest props accessible from URDF load callback
  const samplesRef = useRef(samples);
  const currentTimeRef = useRef(currentTime);
  samplesRef.current = samples;
  currentTimeRef.current = currentTime;

  // ── Three.js 초기화 + URDF 로드 ──────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    const initialWidth = Math.max(1, mount.clientWidth || 320);
    const initialHeight = Math.max(1, mount.clientHeight || 280);
    renderer.setSize(initialWidth, initialHeight, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.shadowMap.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e293b);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 2, 2);
    dirLight.castShadow = true;
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x8ab4ff, 0.4);
    fillLight.position.set(-1, -1, 1);
    scene.add(fillLight);

    // Grid
    const grid = new THREE.GridHelper(0.6, 10, 0x334155, 0x334155);
    scene.add(grid);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, initialWidth / initialHeight || 1, 0.001, 10);
    camera.position.set(0.4, 0.35, 0.45);
    camera.lookAt(0, 0.15, 0);
    cameraRef.current = camera;

    // Simple orbit via pointer drag
    let isDragging = false;
    let prevX = 0, prevY = 0;
    const pivot = new THREE.Object3D();
    pivot.position.set(0, 0.15, 0);
    scene.add(pivot);

    // We'll orbit the camera around the pivot
    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      prevX = e.clientX;
      prevY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      prevX = e.clientX;
      prevY = e.clientY;

      // Orbit around pivot
      const offset = camera.position.clone().sub(pivot.position);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.01;
      spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi + dy * 0.01));
      offset.setFromSpherical(spherical);
      camera.position.copy(pivot.position.clone().add(offset));
      camera.lookAt(pivot.position);
    };
    const onPointerUp = () => { isDragging = false; };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // Wheel zoom
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const offset = camera.position.clone().sub(pivot.position);
      const factor = 1 + e.deltaY * 0.001;
      const newLen = Math.max(0.1, Math.min(2.0, offset.length() * factor));
      offset.setLength(newLen);
      camera.position.copy(pivot.position.clone().add(offset));
    };
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    // URDF 로드
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    // package://piper_description/meshes/xxx → /api/urdf/meshes/xxx
    loader.packages = { piper_description: "/api/urdf" };
    // workingPath auto-extract를 무시하고 절대 경로를 직접 fetch
    loader.loadMeshCb = (path: string, _mgr: any, done: (mesh: any, err?: any) => void) => {
      // resolvePath가 workingPath를 이중으로 붙이는 경우 정리:
      // e.g. "/api/urdf//api/urdf/meshes/xxx" → "/api/urdf/meshes/xxx"
      let url = path.replace(/\/\//g, "/");
      if (!url.startsWith("/") && !/^https?:\/\//.test(url)) url = `/${url}`;
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); })
        .then(buf => {
          const geom = new STLLoader().parse(buf);
          const mesh = new THREE.Mesh(
            geom,
            new THREE.MeshStandardMaterial({ color: 0xcad0e0, roughness: 0.6, metalness: 0.3 }),
          );
          done(mesh);
        })
        .catch(err => done(null, err));
    };

    loader.load("/api/urdf/piper.urdf", (robot: any) => {
      // ROS URDF는 Z-up; Three.js는 Y-up이므로 -90° X 회전
      robot.rotation.x = -Math.PI / 2;
      scene.add(robot);
      robotRef.current = robot;
      // Apply latest joint angles (in case currentTime changed while loading)
      applyJoints(robot, samplesRef.current, currentTimeRef.current);
      frameRobot(robot, camera, pivot);
    });

    // Render loop
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(([entry]) => {
      const w = Math.max(1, entry.contentRect.width);
      const h = Math.max(1, entry.contentRect.height);
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.lookAt(pivot.position);
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(mount);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      resizeObserver.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      robotRef.current = null;
      cameraRef.current = null;
    };
  }, []);  // mount once

  // ── 관절 각도 업데이트 ────────────────────────────────────────────────
  useEffect(() => {
    applyJoints(robotRef.current, samples, currentTime);
  }, [samples, currentTime]);

  return (
    <div
      ref={mountRef}
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        borderRadius: 6,
        overflow: "hidden",
        cursor: "grab",
        background: "#1e293b",
      }}
    />
  );
}
