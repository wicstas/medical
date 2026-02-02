import { useEffect, useState, useRef } from "react";
import ReactDOM from 'react-dom/client';
import { init as coreInit, RenderingEngine, Enums, metaData, volumeLoader, addVolumesToViewports, setVolumesForViewports } from '@cornerstonejs/core';
import cornerstoneDICOMImageLoader from "@cornerstonejs/dicom-image-loader";
import * as cornerstoneTools from '@cornerstonejs/tools';
import createImageIdsAndCacheMetaData from './createImageIdsAndCacheMetaData';

const {
  PanTool,
  WindowLevelTool,
  StackScrollTool,
  ZoomTool,
  ToolGroupManager,
  synchronizers,
  Enums: csToolsEnums,
  BaseTool,
} = cornerstoneTools;

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
  return mat2(c, -s, s, c);
}
void main(){
vec2 uv = v_uv - vec2(0.5);
vec2 p = rotate(u_tile_rotation) * (uv * u_resolution + u_tile_offset) / u_tile_size;
float m = mod(floor(p.x) + floor(p.y), 2.0);
vec4 a = texture2D(u_texA, v_uv);
vec4 b = texture2D(u_texB, v_uv);
gl_FragColor = mix(a, b, m);
gl_FragColor.w = 1.0;
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
function makeTexture(gl, unit, width, height) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
}
function ToggleButton({ fn, text }) {
  const [isPressed, setIsPressed] = useState(false);

  const handleClick = () => {
    fn(!isPressed);
    const a = isPressed
    setIsPressed((x) => !x);
    console.log(a, isPressed)
  };

  return (
    <button
      onClick={handleClick}
      className={`
        px-4 py-2 rounded border transition
        ${isPressed
          ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
          : "bg-gray-100 text-gray-800 border-gray-300 hover:bg-gray-200"}
      `}
    >
      {text}
    </button>
  );
}

const viewportHeight = 400
const viewportWidth = 400
const toolGroupId = 'myToolGroup';
const renderingEngineId = 'myRenderingEngine';

let renderingEngine;
let toolGroup;

function Viewport({ id, viewportIds, orientation }) {
  const [tileSize, setTileSize] = useState(viewportHeight / 8);
  const [tileRotation, setTileRotation] = useState(0);
  const [tileOffsetX, setTileOffsetX] = useState(0.0);
  const [tileOffsetY, setTileOffsetY] = useState(0.0);
  const canvasA = useRef(null)
  const canvasB = useRef(null)
  const canvasMain = useRef(null)
  const program = useRef(null)
  const texA = useRef(null)
  const texB = useRef(null)
  const [checkerboardView, setCheckerboardView] = useState(false)
  const syncs = useRef(null);

  useEffect(() => {
    const glCanvas = canvasMain.current
    const gl = glCanvas.getContext('webgl');
    if (!gl) { alert('WebGL not available'); }
    program.current = createProgram(gl, vsSource, fsSource);
    gl.useProgram(program.current);

    const posLoc = gl.getAttribLocation(program.current, 'a_pos');
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    texA.current = makeTexture(gl, 0, viewportWidth, viewportHeight);
    texB.current = makeTexture(gl, 1, viewportWidth, viewportHeight);

    gl.uniform1i(gl.getUniformLocation(program.current, 'u_texA'), 0);
    gl.uniform1i(gl.getUniformLocation(program.current, 'u_texB'), 1);

    syncs.current = [synchronizers.createCameraPositionSynchronizer(id + '_sync_cam'), synchronizers.createVOISynchronizer(id + '_sync_voi')];
    const canvases = [canvasA.current, canvasB.current]

    canvases.forEach((element, i) => {
      element.style.width = `${viewportWidth}px`;
      element.style.height = `${viewportHeight}px`;
      const viewportId = viewportIds[i]
      const viewportInput = {
        viewportId,
        element,
        type: Enums.ViewportType.ORTHOGRAPHIC,
        defaultOptions: {
          orientation,
        },
      };
      renderingEngine.enableElement(viewportInput);
      const viewport = renderingEngine.getViewport(viewportId)
      const CScanvas = viewport.getCanvas()
      CScanvas.width = viewportWidth
      CScanvas.height = viewportHeight
      toolGroup.addViewport(viewportId, renderingEngineId);
    });

  }, []);

  useEffect(() => {
    let frameId;
    const glCanvas = canvasMain.current;
    const gl = glCanvas.getContext('webgl');
    if (!gl)
      console.error('WebGL context not available');
    const viewportA = renderingEngine.getViewport(viewportIds[0])
    const viewportB = renderingEngine.getViewport(viewportIds[1])
    const CScanvasA = viewportA.getCanvas()
    const CScanvasB = viewportB.getCanvas()
    const tick = () => {
      updateTextureFromCanvas(gl, texA.current, 0, CScanvasA);
      updateTextureFromCanvas(gl, texB.current, 1, CScanvasB);

      gl.uniform2f(gl.getUniformLocation(program.current, 'u_resolution'), glCanvas.width, glCanvas.height);
      gl.uniform1f(gl.getUniformLocation(program.current, 'u_tile_size'), tileSize);
      gl.uniform1f(gl.getUniformLocation(program.current, 'u_tile_rotation'), tileRotation / 180 * Math.PI);
      gl.uniform2f(gl.getUniformLocation(program.current, 'u_tile_offset'), tileOffsetX, tileOffsetY);

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [tileSize, tileRotation, tileOffsetX, tileOffsetY]);

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
    const onPointerMove = (e) => {
      if (!dragging.current) return;
      setTileOffsetX(tileStartX.current + pointerStartX.current - e.clientX);
      setTileOffsetY(tileStartY.current - pointerStartY.current + e.clientY);
    }
    const onPointerUp = () => dragging.current = false
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);
  return <div>
    <div className="flex">
      <ToggleButton fn={(pressed) => {
        setCheckerboardView(pressed);
      }} text='Checkerboard' />
      <ToggleButton fn={(pressed) => {
        viewportIds.forEach((viewportId) => {
          if (pressed)
            syncs.current.forEach(sync => sync.add({ renderingEngineId, viewportId }));
          else
            syncs.current.forEach(sync => sync.remove({ renderingEngineId, viewportId }));
        });
      }} text='Enable Sync' />
    </div>
    <div className={`relative w-[${viewportWidth}px] h-[${viewportHeight}px]`}>
      <div className='flex-col justify-start items-center'>
        <div className='flex justify-start items-center'>
          <div className='text-center'>Tile size:</div>
          <input
            type="range"
            min={viewportHeight / 8}
            max={viewportHeight / 2}
            value={tileSize}
            onChange={(e) => setTileSize(Number(e.target.value))}
            className="w-50 h-10"
          />
          <div className='text-center'>{tileSize}px</div>
        </div>
        <div className='flex justify-start items-center'>
          <div className='text-center'>Tile rotation:</div>
          <input
            type="range"
            min="0"
            max="360"
            value={tileRotation}
            onChange={(e) => setTileRotation(Number(e.target.value))}
            className="w-50 h-10"
          />
          <div className='text-center'>{tileRotation}px</div>
        </div>
      </div>
      <div className='relative' style={{ width: viewportWidth, height: viewportHeight }}>
        <canvas ref={canvasMain} id="canvasMain" width={viewportWidth} height={viewportHeight} className={'absolute z-10 pointer-events-none ' + (checkerboardView ? `` : `hidden`)}></canvas>
        {checkerboardView &&
          <div
            onPointerDown={onPointerDown}
            className={"absolute z-20 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500 size-5 flex justify-center content-center items-center select-none"}
          ></div>
        }
        <div ref={canvasA} id="canvasA" className={checkerboardView ? 'absolute z-0 pointer-events-auto' : ''}></div>
        <div ref={canvasB} id="canvasB" className={checkerboardView ? 'absolute z-0 pointer-events-auto' : ''}></div>
      </div>
    </div>
  </div>

}

const allViewportIds = ['AXIAL_A', 'AXIAL_B', 'CORONAL_A', 'CORONAL_B', 'SAGITTAL_A', 'SAGITTAL_B']

function App() {
  return <div>
    Select First Scan:&nbsp;
    <input type="file" className='border border-black' onChange={async (e) => {
      const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(e.target.files[0]);
      await prefetchMetadataInformation([imageId]);
      const imageIds = convertMultiframeImageIds([imageId])
      const volumeId = "volumeA-" + e.target.files[0].name
      const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
      await volume.load();
      await setVolumesForViewports(
        renderingEngine,
        [{ volumeId }],
        [allViewportIds[0], allViewportIds[2], allViewportIds[4]]
      );
      renderingEngine.renderViewports([allViewportIds[0], allViewportIds[2], allViewportIds[4]]
      );
    }}></input>

    Select Second Scan:&nbsp;
    <input type="file" className='border border-black' onChange={async (e) => {
      const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(e.target.files[0]);
      await prefetchMetadataInformation([imageId]);
      const imageIds = convertMultiframeImageIds([imageId])
      const volumeId = "volumeB-" + e.target.files[0].name
      const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
      await volume.load();
      await setVolumesForViewports(
        renderingEngine,
        [{ volumeId }],
        [allViewportIds[1], allViewportIds[3], allViewportIds[5]]
      );

      renderingEngine.renderViewports([allViewportIds[1], allViewportIds[3], allViewportIds[5]]);
    }}></input>

    <div className='flex pt-5'>
      <Viewport id='VP0' viewportIds={[allViewportIds[0], allViewportIds[1]]} orientation={Enums.OrientationAxis.AXIAL} />
      <Viewport id='VP1' viewportIds={[allViewportIds[2], allViewportIds[3]]} orientation={Enums.OrientationAxis.CORONAL} />
      <Viewport id='VP2' viewportIds={[allViewportIds[4], allViewportIds[5]]} orientation={Enums.OrientationAxis.SAGITTAL} />
    </div>
  </div >
}

async function start() {
  await coreInit();
  await cornerstoneDICOMImageLoader.init();
  await cornerstoneTools.init();

  const { MouseBindings } = csToolsEnums;
  cornerstoneTools.addTool(WindowLevelTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(StackScrollTool);
  toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary, },], });
  toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary },], });
  toolGroup.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary, }], });
  toolGroup.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }], });

  renderingEngine = new RenderingEngine(renderingEngineId);

  const loadFromServer = false
  if (loadFromServer) {
    const imageIds = await createImageIdsAndCacheMetaData({
      StudyInstanceUID:
        '1.2.276.0.7230010.3.1.2.8323329.46581.1769838608.398825',
      SeriesInstanceUID:
        '1.2.276.0.7230010.3.1.3.8323329.46581.1769838608.398826',
      wadoRsRoot: '/orthancUrl/dicom-web/',
    });
    const volumeId = "volumeA"
    const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
    volume.load();
    setVolumesForViewports(
      renderingEngine,
      [{ volumeId }],
      [allViewportIds[0], allViewportIds[2], allViewportIds[4]]
    );
  }
  if (loadFromServer) {
    const imageIds = await createImageIdsAndCacheMetaData({
      StudyInstanceUID:
        '1.2.276.0.7230010.3.1.2.8323329.46581.1769838608.398825',
      SeriesInstanceUID:
        '1.2.276.0.7230010.3.1.3.8323329.46581.1769838608.398826',
      wadoRsRoot: '/orthancUrl/dicom-web/',
    });
    const volumeId = "volumeB"
    const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds })
    volume.load();
    setVolumesForViewports(
      renderingEngine,
      [{ volumeId }],
      [allViewportIds[1], allViewportIds[3], allViewportIds[5]]
    );
  }
  renderingEngine.renderViewports(allViewportIds);

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    <App />
  );
}

start()