import React from 'react';
import { useEffect, useState, useRef } from "react";
import ReactDOM from 'react-dom/client';
import { RenderingEngine, Enums, metaData, init as coreInit } from '@cornerstonejs/core';
import { imageLoader } from '@cornerstonejs/core/loaders';
import { calibratedPixelSpacingMetadataProvider, getPixelSpacingInformation, renderToCanvasGPU } from "@cornerstonejs/core/utilities";
import cornerstoneDICOMImageLoader from "@cornerstonejs/dicom-image-loader";
import * as cornerstoneTools from '@cornerstonejs/tools';

async function prefetchMetadataInformation(imageIdsToPrefetch) {
  for (let i = 0; i < imageIdsToPrefetch.length; i++) {
    await cornerstoneDICOMImageLoader.wadouri.loadImage(imageIdsToPrefetch[i])
      .promise;
  }
}

function getFrameInformation(imageId) {
  if (imageId.includes('wadors:')) {
    const frameIndex = imageId.indexOf('/frames/');
    const imageIdFrameless =
      frameIndex > 0 ? imageId.slice(0, frameIndex + 8) : imageId;
    return {
      frameIndex,
      imageIdFrameless,
    };
  } else {
    const frameIndex = imageId.indexOf('&frame=');
    let imageIdFrameless =
      frameIndex > 0 ? imageId.slice(0, frameIndex + 7) : imageId;
    if (!imageIdFrameless.includes('&frame=')) {
      imageIdFrameless = imageIdFrameless + '&frame=';
    }
    return {
      frameIndex,
      imageIdFrameless,
    };
  }
}
function convertMultiframeImageIds(imageIds) {
  const newImageIds = [];
  imageIds.forEach((imageId) => {
    const { imageIdFrameless } = getFrameInformation(imageId);
    const instanceMetaData = metaData.get('multiframeModule', imageId);
    if (
      instanceMetaData &&
      instanceMetaData.NumberOfFrames &&
      instanceMetaData.NumberOfFrames > 1
    ) {
      const NumberOfFrames = instanceMetaData.NumberOfFrames;
      for (let i = 0; i < NumberOfFrames; i++) {
        const newImageId = imageIdFrameless + (i + 1);
        newImageIds.push(newImageId);
      }
    } else {
      newImageIds.push(imageId);
    }
  });
  return newImageIds;
}

async function setImage(imageId) {
  await prefetchMetadataInformation([imageId]);
  const stack = convertMultiframeImageIds([imageId]);
  await viewport.setImage(imageId[0], 0)
  await viewport.setImage(imageId[1], 0)
  viewport.render();

  const imageData = viewport.getImageData();

  const {
    pixelRepresentation,
    bitsAllocated,
    bitsStored,
    highBit,
    photometricInterpretation,
  } = metaData.get('imagePixelModule', imageId);
}

const vsSource = `#version 100
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos,0.0,1.0); }
`;
const fsSource = `#version 100
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform float u_tile_size;
uniform float u_tile_rotation;
uniform vec2 u_tile_offset;
uniform vec2 u_resolution;

mat2 rotate(float rad) {
  float c = cos(rad);
  float s = sin(rad);
  return mat2(c, s, s, c);
}
void main(){
vec2 p = rotate(u_tile_rotation) * ((v_uv - vec2(0.5)) * u_resolution + u_tile_offset) / u_tile_size;
float m = mod(floor(p.x) + floor(p.y), 2.0);
vec4 a = texture2D(u_texA, v_uv);
vec4 b = texture2D(u_texB, v_uv);
gl_FragColor = mix(a, b, m);
}
`;
function createShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
    gl.deleteShader(s); return null;
  }
  return s;
}
function createProgram(gl, vsSrc, fsSrc) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(p)); gl.deleteProgram(p); return null;
  }
  return p;
}
function makeTexture(gl, unit) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}
function updateTextureFromCanvas(gl, tex, unit, canvas) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
}

let program
let texA, texB

const viewportHeight = 400
const viewportWidth = 400

function App() {
  const [dummy, setDummy] = useState(0);
  const [tileSize, setTileSize] = useState(viewportHeight / 8);
  const [tileRotation, setTileRotation] = useState(0);
  const [tileOffsetX, setTileOffsetX] = useState(0.0);
  const [tileOffsetY, setTileOffsetY] = useState(0.0);

  useEffect(() => {
    const glCanvas = document.getElementById('canvasMain');
    const gl = glCanvas.getContext('webgl');
    if (!gl) { alert('WebGL not available'); }
    program = createProgram(gl, vsSource, fsSource);
    gl.useProgram(program);

    const posLoc = gl.getAttribLocation(program, 'a_pos');
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    texA = makeTexture(gl, 0);
    texB = makeTexture(gl, 1);

    gl.uniform1i(gl.getUniformLocation(program, 'u_texA'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_texB'), 1);
  }, []);

  useEffect(() => {
    const glCanvas = document.getElementById('canvasMain');
    const gl = glCanvas.getContext('webgl');

    const canvasA = document.getElementById('canvasA');
    const canvasB = document.getElementById('canvasB');
    const ctxA = canvasA.getContext('2d');
    const ctxB = canvasB.getContext('2d');

    updateTextureFromCanvas(gl, texA, 0, canvasA);
    updateTextureFromCanvas(gl, texB, 1, canvasB);
  }, [dummy]);
  useEffect(() => {
    const glCanvas = document.getElementById('canvasMain');
    const gl = glCanvas.getContext('webgl');
    console.log(glCanvas.width, glCanvas.height)
    gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), glCanvas.width, glCanvas.height);
    gl.uniform1f(gl.getUniformLocation(program, 'u_tile_size'), tileSize);
    gl.uniform1f(gl.getUniformLocation(program, 'u_tile_rotation'), tileRotation / 180 * Math.PI);
    gl.uniform2f(gl.getUniformLocation(program, 'u_tile_offset'), tileOffsetX, tileOffsetY);

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [dummy, tileSize, tileRotation, tileOffsetX, tileOffsetY]);

  const dragging = useRef(false);
  const tileStartX = useRef(0.0);
  const tileStartY = useRef(0.0);
  const pointerStartX = useRef(0.0);
  const pointerStartY = useRef(0.0);

  const onPointerDown = (e) => {
    dragging.current = true;
    pointerStartX.current = e.clientX;
    pointerStartY.current = e.clientY;
    tileStartX.current = tileOffsetX
    tileStartY.current = tileOffsetY
  };
  useEffect(() => {
    window.addEventListener("pointermove", (e) => {
      if (!dragging.current) return;
      setTileOffsetX(tileStartX.current + pointerStartX.current - e.clientX);
      setTileOffsetY(tileStartY.current - pointerStartY.current + e.clientY);
    });
    window.addEventListener("pointerup", () => dragging.current = false)
  }, []);

  return <div className={`relative w-[${viewportWidth}px] h-[${viewportHeight}px]`}>
    <input type="file" onChange={async (e) => {
      const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(e.target.files[0]);
      const image = await imageLoader.loadImage(imageId);
      const canvasA = document.getElementById('canvasA');
      renderToCanvasGPU(canvasA, image);
      setDummy(dummy + 1);
    }}></input>
    <canvas id="canvasA" width={viewportWidth} height={viewportHeight} className="hidden"></canvas>

    <input type="file" onChange={async (e) => {
      const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(e.target.files[0]);
      const image = await imageLoader.loadImage(imageId);
      const canvasB = document.getElementById('canvasB');
      renderToCanvasGPU(canvasB, image);
      setDummy(dummy + 1);
    }}></input>
    <canvas id="canvasB" width={viewportWidth} height={viewportHeight} className="hidden"></canvas>

    <div className='flex justify-start items-center'>
      <div className='text-center pr-5'>Tile size:</div>
      <input
        type="range"
        min={viewportHeight / 8}
        max={viewportHeight / 2}
        value={tileSize}
        onChange={(e) => setTileSize(Number(e.target.value))}
        className="w-100 h-10"
      />
      <div className='text-center pl-5'>{tileSize}px</div>
      <div className='text-center px-5'>Tile rotation:</div>
      <input
        type="range"
        min="0"
        max="360"
        value={tileRotation}
        onChange={(e) => setTileRotation(Number(e.target.value))}
        className="w-100 h-10"
      />
      <div className='text-center pl-5'>{tileRotation}px</div>
      <div className='text-center px-5'>Tile offset:</div>
      <div className='text-center'>({tileOffsetX}, {tileOffsetY})</div>
    </div>
    <canvas id="canvasMain" width={viewportWidth} height={viewportHeight}>
    </canvas>
    <div
      onPointerDown={onPointerDown}
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500 size-10 flex justify-center content-center items-center select-none"
    >
    </div>
  </div>;
}

async function start() {
  await coreInit();
  await cornerstoneDICOMImageLoader.init();
  await cornerstoneTools.init();

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<App />);
}

start()