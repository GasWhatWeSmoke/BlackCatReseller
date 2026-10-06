"use client";
import { useEffect } from "react";
export function SurfaceMotion() {
  useEffect(() => {
    const media=matchMedia("(prefers-reduced-motion: reduce)");
    const sync=()=>{let motion="full";try{motion=localStorage.getItem("blackcat.motion")||"full";}catch{}document.documentElement.dataset.motion=media.matches?"off":motion;};
    sync();window.addEventListener("blackcat:appearance",sync);media.addEventListener("change",sync);
    let active:HTMLElement|null=null,frame=0,x=0,y=0;
    const reset=()=>{if(active){active.style.removeProperty("--rx");active.style.removeProperty("--ry");active=null;}};
    const move=(event:PointerEvent)=>{
      if(document.documentElement.dataset.motion!=="full"||event.pointerType==="touch"){reset();return;}
      const target=(event.target as HTMLElement).closest<HTMLElement>("[data-depth]");
      if(target!==active)reset();if(!target)return;active=target;x=event.clientX;y=event.clientY;
      if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(!active)return;const box=active.getBoundingClientRect();const px=Math.max(0,Math.min(1,(x-box.left)/box.width)),py=Math.max(0,Math.min(1,(y-box.top)/box.height));active.style.setProperty("--rx",`${(py-.5)*-1.4}deg`);active.style.setProperty("--ry",`${(px-.5)*1.4}deg`);active.style.setProperty("--light-x",`${px*100}%`);});
    };
    document.addEventListener("pointermove",move,{passive:true});document.addEventListener("pointerleave",reset);
    return()=>{reset();cancelAnimationFrame(frame);document.removeEventListener("pointermove",move);document.removeEventListener("pointerleave",reset);window.removeEventListener("blackcat:appearance",sync);media.removeEventListener("change",sync);};
  },[]);
  return null;
}
