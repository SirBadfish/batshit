import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { cubicOut } from "svelte/easing";

export function cn(...inputs: any[]) {
    return twMerge(clsx(inputs));
}

// Type exports for shadcn-svelte components
export type WithElementRef<T, E = HTMLElement> = T & { ref?: E | null };
export type WithoutChildrenOrChild<T> = Omit<T, 'children' | 'child'>;
export type WithoutChildren<T> = Omit<T, 'children'>;
export type WithoutChild<T> = Omit<T, 'child'>;

export const flyAndScale = (
    node: HTMLElement,
    params = { y: -8, x: 0, start: 0.95, duration: 150 }
) => {
    const style = getComputedStyle(node);
    const transform = style.transform === "none" ? "" : style.transform;

    const scaleConversion = (valueA: number, valueB: number) => {
        const scaleA = valueA / 100;
        const scaleB = valueB / 100;
        return { x: scaleB, y: scaleA };
    };

    const styleToString = (style: Record<string, any>) => {
        return Object.keys(style).reduce((str, key) => {
            if (style[key] === undefined) return str;
            return str + `${key}:${style[key]};`;
        }, "");
    };

    return {
        duration: params.duration ?? 200,
        delay: 0,
        css: (t: number) => {
            const y = scaleConversion(params.y ?? 5, 0);
            const x = scaleConversion(params.x ?? 0, 0);
            const scale = scaleConversion(params.start ?? 95, 100);

            return styleToString({
                transform: `${transform} translate3d(${x.x * (1 - t)}px, ${
                    y.y * (1 - t)
                }px, 0) scale(${
                    scale.x + (1 - scale.x) * t
                }, ${scale.y + (1 - scale.y) * t})`,
                opacity: t
            });
        },
        easing: cubicOut
    };
};