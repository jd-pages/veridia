"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./results-workbench.module.css";

interface ScrollbarLayout {
  visible: boolean;
  left: number;
  width: number;
  thumbWidth: number;
  thumbLeft: number;
}

const initialLayout: ScrollbarLayout = {
  visible: false,
  left: 0,
  width: 0,
  thumbWidth: 0,
  thumbLeft: 0,
};

export default function StickyHorizontalScrollbar({
  children,
}: {
  children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startScrollLeft: number;
  } | null>(null);
  const [layout, setLayout] = useState<ScrollbarLayout>(initialLayout);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const update = () => {
      const table =
        tableRef.current ||
        host.querySelector<HTMLElement>(".ant-table-body");
      tableRef.current = table;
      if (!table) {
        setLayout(initialLayout);
        return;
      }
      const rect = table.getBoundingClientRect();
      const width = table.clientWidth;
      const scrollRange = table.scrollWidth - width;
      const bottomReached = rect.bottom <= window.innerHeight + 12;
      const intersectsViewport =
        rect.top < window.innerHeight - 8 && rect.bottom > 72;
      const visible =
        scrollRange > 1 && intersectsViewport && !bottomReached;
      const thumbWidth = Math.max(
        54,
        Math.min(width, (width / table.scrollWidth) * width),
      );
      const thumbRange = Math.max(width - thumbWidth, 0);
      const thumbLeft =
        scrollRange > 0
          ? Math.min(
              thumbRange,
              Math.max(0, (table.scrollLeft / scrollRange) * thumbRange),
            )
          : 0;
      setLayout({
        visible,
        left: rect.left,
        width,
        thumbWidth,
        thumbLeft,
      });
    };

    const bindTable = () => {
      const nextTable = host.querySelector<HTMLElement>(".ant-table-body");
      if (nextTable === tableRef.current) return;
      tableRef.current?.removeEventListener("scroll", update);
      tableRef.current = nextTable;
      nextTable?.addEventListener("scroll", update, { passive: true });
      update();
    };

    bindTable();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(host);
    const mutationObserver = new MutationObserver(() => {
      bindTable();
      update();
    });
    mutationObserver.observe(host, { childList: true, subtree: true });
    update();

    return () => {
      tableRef.current?.removeEventListener("scroll", update);
      tableRef.current = null;
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const table = tableRef.current;
      if (!drag || !table) return;
      const scrollRange = table.scrollWidth - table.clientWidth;
      const thumbRange = layout.width - layout.thumbWidth;
      if (scrollRange <= 0 || thumbRange <= 0) return;
      const next =
        drag.startScrollLeft +
        ((event.clientX - drag.startX) / thumbRange) * scrollRange;
      table.scrollLeft = Math.max(0, Math.min(scrollRange, next));
    };
    const onPointerUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [layout.thumbWidth, layout.width]);

  return (
    <div ref={hostRef} className={styles.stickyHost}>
      {children}
      {layout.visible ? (
        <div
          className={styles.floatingScroll}
          data-testid="results-floating-scrollbar"
          style={{ left: layout.left, width: layout.width }}
          aria-label="审核结果横向滚动条"
        >
          <div
            className={styles.floatingThumb}
            data-testid="results-floating-scrollbar-thumb"
            style={{
              width: layout.thumbWidth,
              transform: `translate3d(${layout.thumbLeft}px, 0, 0)`,
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              dragRef.current = {
                startX: event.clientX,
                startScrollLeft: tableRef.current?.scrollLeft || 0,
              };
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
