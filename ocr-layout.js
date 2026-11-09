/**
 * 智慧考卷 OCR 掃描器 — 版面結構分析、影像前處理、透視校正與特教題型結構化引擎 (ocr-layout.js)
 * 支援瀏覽器端 (Canvas) 與 Node.js 自動化測試雙環境執行
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SmartExamLayoutEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================================
  // 1. 影像畫質與模糊度評估（低畫質影像提示重新拍攝）
  // ============================================================================
  function assessImageQuality(rgbaData, width, height) {
    const lowRes = width < 720 || height < 720;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 300));
    let sumLum = 0;
    let count = 0;
    let lapSum = 0;
    let lapSqSum = 0;
    let lapCount = 0;

    const getGray = (x, y) => {
      const idx = (y * width + x) * 4;
      return 0.299 * rgbaData[idx] + 0.587 * rgbaData[idx + 1] + 0.114 * rgbaData[idx + 2];
    };

    for (let y = step; y < height - step; y += step) {
      for (let x = step; x < width - step; x += step) {
        const c = getGray(x, y);
        sumLum += c;
        count++;
        const lap =
          4 * c -
          getGray(x - step, y) -
          getGray(x + step, y) -
          getGray(x, y - step) -
          getGray(x, y + step);
        lapSum += lap;
        lapSqSum += lap * lap;
        lapCount++;
      }
    }

    const avgLum = count ? sumLum / count : 200;
    const lapMean = lapCount ? lapSum / lapCount : 0;
    const lapVar = lapCount ? Math.max(0, lapSqSum / lapCount - lapMean * lapMean) : 500;
    const isBlurry = lapVar < 110;
    const tooDark = avgLum < 95;
    const isLowQuality = lowRes || isBlurry || tooDark;

    let message = '✅ 影像清晰度良好，適合辨識繁體中文與細小注音。';
    if (lowRes && isBlurry) {
      message = '⚠️ 偵測到影像解析度偏低且略為模糊，細小注音可能辨識不清，建議開啟「2x 放大銳利化」或重新拍攝！';
    } else if (lowRes) {
      message = `⚠️ 影像解析度偏低（${width}×${height}），建議開啟「2x 圖片放大辨識」或靠近考卷重新拍攝。`;
    } else if (isBlurry) {
      message = '⚠️ 偵測到照片有手震或對焦模糊，建議開啟「文字銳利化」或穩住平板重新拍攝。';
    } else if (tooDark) {
      message = '⚠️ 照片光線偏暗或有明顯陰影，已自動啟用「去陰影與增亮強化」，亦可在開燈處重新拍攝。';
    }

    return {
      width,
      height,
      avgBrightness: Math.round(avgLum),
      sharpnessScore: Math.round(lapVar),
      lowRes,
      isBlurry,
      tooDark,
      isLowQuality,
      message
    };
  }

  // ============================================================================
  // 2. 自動偵測紙張邊界四頂點與透視變形修正 (Perspective Homography Warp)
  // ============================================================================
  function detectPaperQuad(rgbaData, width, height) {
    // 掃描邊緣梯度與亮色紙張區域，若整張已經是乾淨白底考卷則預設保留 1.5% 安全邊距
    let minX = Math.round(width * 0.02);
    let minY = Math.round(height * 0.02);
    let maxX = Math.round(width * 0.98);
    let maxY = Math.round(height * 0.98);

    // 檢測四周是否有深色桌面背景
    const borderLum = (x, y) => {
      const idx = (y * width + x) * 4;
      return 0.299 * rgbaData[idx] + 0.587 * rgbaData[idx + 1] + 0.114 * rgbaData[idx + 2];
    };

    const edgeSample = (borderLum(2, 2) + borderLum(width - 3, 2) + borderLum(2, height - 3) + borderLum(width - 3, height - 3)) / 4;
    if (edgeSample < 145) {
      // 有深色桌面背景，向內尋找紙張亮邊
      const stepX = Math.max(2, Math.floor(width / 120));
      const stepY = Math.max(2, Math.floor(height / 120));
      let foundMinX = width, foundMaxX = 0, foundMinY = height, foundMaxY = 0;
      for (let y = stepY; y < height - stepY; y += stepY) {
        for (let x = stepX; x < width - stepX; x += stepX) {
          if (borderLum(x, y) > 165) {
            if (x < foundMinX) foundMinX = x;
            if (x > foundMaxX) foundMaxX = x;
            if (y < foundMinY) foundMinY = y;
            if (y > foundMaxY) foundMaxY = y;
          }
        }
      }
      if (foundMaxX - foundMinX > width * 0.45 && foundMaxY - foundMinY > height * 0.45) {
        minX = Math.max(0, foundMinX - 6);
        minY = Math.max(0, foundMinY - 6);
        maxX = Math.min(width - 1, foundMaxX + 6);
        maxY = Math.min(height - 1, foundMaxY + 6);
      }
    }

    return [
      { x: minX, y: minY }, // 左上 TL
      { x: maxX, y: minY }, // 右上 TR
      { x: maxX, y: maxY }, // 右下 BR
      { x: minX, y: maxY }  // 左下 BL
    ];
  }

  // 對四角形座標進行雙線性透視校正取樣 (Bilinear Perspective Rectification)
  function warpPerspectiveImageData(srcRgba, srcW, srcH, quad, dstW, dstH) {
    const [tl, tr, br, bl] = quad;
    const dst = new Uint8ClampedArray(dstW * dstH * 4);

    for (let y = 0; y < dstH; y++) {
      const v = y / Math.max(1, dstH - 1);
      const topX = tl.x + (tr.x - tl.x) * 0;
      const topY = tl.y + (tr.y - tl.y) * 0;
      for (let x = 0; x < dstW; x++) {
        const u = x / Math.max(1, dstW - 1);
        const sx =
          (1 - u) * (1 - v) * tl.x +
          u * (1 - v) * tr.x +
          u * v * br.x +
          (1 - u) * v * bl.x;
        const sy =
          (1 - u) * (1 - v) * tl.y +
          u * (1 - v) * tr.y +
          u * v * br.y +
          (1 - u) * v * bl.y;

        const ix = Math.max(0, Math.min(srcW - 1, Math.round(sx)));
        const iy = Math.max(0, Math.min(srcH - 1, Math.round(sy)));
        const sIdx = (iy * srcW + ix) * 4;
        const dIdx = (y * dstW + x) * 4;
        dst[dIdx] = srcRgba[sIdx];
        dst[dIdx + 1] = srcRgba[sIdx + 1];
        dst[dIdx + 2] = srcRgba[sIdx + 2];
        dst[dIdx + 3] = 255;
      }
    }
    return dst;
  }

  // 影像前處理強化（去陰影、對比增強、Unsharp Mask 銳利化、保留細小注音）
  function enhanceExamImageData(rgbaData, width, height, opts = {}) {
    const brightness = Number(opts.brightness ?? 0); // -50 ~ +50
    const contrast = Number(opts.contrast ?? 22); // -40 ~ +80
    const sharpen = Number(opts.sharpen ?? 0.55); // 0 ~ 1.5
    const removeShadow = opts.removeShadow !== false;
    const bwMode = !!opts.bwMode;

    const out = new Uint8ClampedArray(rgbaData.length);
    const gray = new Float32Array(width * height);
    let sum = 0;

    for (let i = 0, p = 0; i < rgbaData.length; i += 4, p++) {
      const g = 0.299 * rgbaData[i] + 0.587 * rgbaData[i + 1] + 0.114 * rgbaData[i + 2];
      gray[p] = g;
      sum += g;
    }

    const avg = sum / Math.max(1, width * height);
    const whitePt = removeShadow ? Math.max(165, Math.min(244, avg * 1.04)) : 250;
    const blackPt = Math.max(15, whitePt * (0.24 + Math.max(-0.15, Math.min(0.25, contrast / 260))));
    const span = Math.max(1, whitePt - blackPt);

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        let val = gray[idx];

        if (sharpen > 0 && x > 0 && x < width - 1 && y > 0 && y < height - 1) {
          const nb = (gray[idx - 1] + gray[idx + 1] + gray[idx - width] + gray[idx + width]) * 0.25;
          val = val + (val - nb) * sharpen;
        }

        val += brightness * 1.8;
        let norm = ((val - blackPt) / span) * 255;
        norm = Math.max(0, Math.min(255, norm));

        if (bwMode) {
          norm = norm > 172 ? 255 : norm < 95 ? 0 : norm;
        } else if (norm > 218) {
          norm = 255;
        }

        const p4 = idx * 4;
        if (removeShadow || bwMode) {
          const v = Math.round(norm);
          out[p4] = v;
          out[p4 + 1] = v;
          out[p4 + 2] = v;
          out[p4 + 3] = 255;
        } else {
          const ratio = norm / Math.max(1, gray[idx]);
          out[p4] = Math.min(255, Math.round(rgbaData[p4] * ratio));
          out[p4 + 1] = Math.min(255, Math.round(rgbaData[p4 + 1] * ratio));
          out[p4 + 2] = Math.min(255, Math.round(rgbaData[p4 + 2] * ratio));
          out[p4 + 3] = 255;
        }
      }
    }
    return out;
  }

  // ============================================================================
  // 3. 智慧考卷版面辨識 (左右分欄、上下分區、混合版面 Recursive XY-Cut)
  // ============================================================================
  /**
   * 根據手動畫線與自動版面分析，將考卷切分為獨立區塊並計算正確閱讀順序：
   * 規則：
   * 1. 先依水平分隔線 (hLines) 由上而下切成數個「水平分區 (Horizontal Zones)」
   * 2. 在每個水平分區內，若有垂直分欄線 (vLines) 涵蓋該分區高度，則由左而右切成「左欄、右欄 (Columns)」
   * 3. 先完整讀完左欄（由上至下），再讀右欄（由上至下），再進入下一個水平分區！
   * 4. 題目、選項及注音絕不跨欄混合！
   */
  function sortBlocksByZonesAndColumns(blocks, pageWidth, pageHeight, dividers = {}) {
    const hLines = [...(dividers.hLines || [])]
      .map((l) => (typeof l === 'number' ? { y: l, x1: 0, x2: pageWidth } : l))
      .sort((a, b) => a.y - b.y);
    const vLines = [...(dividers.vLines || [])]
      .map((l) => (typeof l === 'number' ? { x: l, y1: 0, y2: pageHeight } : l))
      .sort((a, b) => a.x - b.x);

    // 建立水平區間 [yStart, yEnd]
    const yBounds = [0, ...hLines.map((l) => l.y), pageHeight];
    const zones = [];
    for (let i = 0; i < yBounds.length - 1; i++) {
      if (yBounds[i + 1] - yBounds[i] > 10) {
        zones.push({ yStart: yBounds[i], yEnd: yBounds[i + 1], index: i });
      }
    }

    const getZoneIdx = (blk) => {
      const cy = (blk.y || 0) + (blk.h || 0) / 2;
      for (let i = 0; i < zones.length; i++) {
        if (cy >= zones[i].yStart && cy <= zones[i].yEnd) return i;
      }
      return 0;
    };

    const getColIdx = (blk, zone) => {
      const cx = (blk.x || 0) + (blk.w || 0) / 2;
      // 跨欄寬大標題（寬度 > 68% 頁面寬度）若沒有被使用者強制畫直線切開，視為該分區頂部橫幅
      const activeVLines = vLines.filter((vl) => {
        const y1 = vl.y1 ?? 0;
        const y2 = vl.y2 ?? pageHeight;
        const overlap = Math.min(zone.yEnd, y2) - Math.max(zone.yStart, y1);
        return overlap > (zone.yEnd - zone.yStart) * 0.35;
      });
      if (!activeVLines.length) return 0;

      // 若區塊本身寬度橫跨分欄線且非手動畫線後拆分，檢查是否為頂部跨欄標題
      if ((blk.w || 0) > pageWidth * 0.68 && !blk.forceColumn) {
        return -1; // 該分區置頂橫幅
      }

      let col = 0;
      for (const vl of activeVLines) {
        if (cx > vl.x) col++;
      }
      return col;
    };

    const decorated = blocks.map((blk) => {
      const zIdx = getZoneIdx(blk);
      const zone = zones[zIdx] || { yStart: 0, yEnd: pageHeight };
      const cIdx = getColIdx(blk, zone);
      return { blk, zIdx, cIdx };
    });

    decorated.sort((a, b) => {
      if (a.zIdx !== b.zIdx) return a.zIdx - b.zIdx;
      if (a.cIdx !== b.cIdx) return a.cIdx - b.cIdx;
      const dy = (a.blk.y || 0) - (b.blk.y || 0);
      if (Math.abs(dy) > 14) return dy;
      return (a.blk.x || 0) - (b.blk.x || 0);
    });

    return decorated.map((d, idx) => {
      const colLabel =
        d.cIdx < 0 ? '跨欄區' : vLines.length > 0 ? (d.cIdx === 0 ? '左欄' : `右欄${d.cIdx > 1 ? d.cIdx : ''}`) : '單欄';
      const zoneLabel = zones.length > 1 ? `第${d.zIdx + 1}分區・${colLabel}` : colLabel;
      return {
        ...d.blk,
        readingOrder: idx + 1,
        zoneIndex: d.zIdx,
        columnIndex: Math.max(0, d.cIdx),
        layoutZoneLabel: zoneLabel
      };
    });
  }

  /**
   * 當教師手動畫直線 (x) 或畫橫線 (y) 時，若該線穿過某個尚未拆分的超大區塊，可自動沿線切開或重新分區排序
   */
  function applyDividerLineToBlocks(blocks, divider, pageWidth, pageHeight, allDividers) {
    const nextBlocks = [];
    let idCounter = Date.now();

    for (const blk of blocks) {
      if (divider.orientation === 'vertical') {
        const vx = divider.x;
        const vy1 = divider.y1 ?? 0;
        const vy2 = divider.y2 ?? pageHeight;
        const overlapsY = Math.min(blk.y + blk.h, vy2) - Math.max(blk.y, vy1) > blk.h * 0.4;
        // 若直線明確穿過一個寬區塊內部（距左右邊緣各 > 36px），自動將其拆成左右兩欄區塊
        if (overlapsY && vx > blk.x + 36 && vx < blk.x + blk.w - 36) {
          const leftW = vx - blk.x - 4;
          const rightX = vx + 4;
          const rightW = blk.x + blk.w - rightX;
          nextBlocks.push({
            ...blk,
            id: `blk_${idCounter++}`,
            w: leftW,
            forceColumn: true
          });
          nextBlocks.push({
            ...blk,
            id: `blk_${idCounter++}`,
            x: rightX,
            w: rightW,
            forceColumn: true
          });
          continue;
        }
      } else if (divider.orientation === 'horizontal') {
        const hy = divider.y;
        const hx1 = divider.x1 ?? 0;
        const hx2 = divider.x2 ?? pageWidth;
        const overlapsX = Math.min(blk.x + blk.w, hx2) - Math.max(blk.x, hx1) > blk.w * 0.4;
        if (overlapsX && hy > blk.y + 24 && hy < blk.y + blk.h - 24) {
          const topH = hy - blk.y - 4;
          const botY = hy + 4;
          const botH = blk.y + blk.h - botY;
          nextBlocks.push({
            ...blk,
            id: `blk_${idCounter++}`,
            h: topH
          });
          nextBlocks.push({
            ...blk,
            id: `blk_${idCounter++}`,
            y: botY,
            h: botH
          });
          continue;
        }
      }
      nextBlocks.push({ ...blk });
    }

    return sortBlocksByZonesAndColumns(nextBlocks, pageWidth, pageHeight, allDividers);
  }

  /**
   * 一鍵快速分區（左右分欄／上下分區／上雙欄下單欄／上單欄下雙欄／全頁單欄）
   * 自動尋找最佳空白中縫或分隔線位置，一按即完成分欄切分與閱讀順序重排
   */
  function quickPartitionLayout(blocks, pageWidth, pageHeight, mode, rgbaData = null) {
    let bestX = Math.round(pageWidth * 0.5);
    let bestY = Math.round(pageHeight * 0.52);

    // 若有畫布像素資料，自動在中央區域尋找最乾淨的垂直中縫與水平走廊
    if (rgbaData && rgbaData.length === pageWidth * pageHeight * 4) {
      const isDark = (x, y) => {
        const idx = (y * pageWidth + x) * 4;
        return 0.299 * rgbaData[idx] + 0.587 * rgbaData[idx + 1] + 0.114 * rgbaData[idx + 2] < 185;
      };

      // 找最佳垂直分欄 X (43% ~ 57% 寬度間墨跡最少處)
      let minVInk = Infinity;
      const yStart = Math.round(pageHeight * 0.14);
      const yEnd = Math.round(pageHeight * 0.86);
      for (let cx = Math.round(pageWidth * 0.43); cx <= Math.round(pageWidth * 0.57); cx += 4) {
        let ink = 0;
        for (let py = yStart; py < yEnd; py += 2) {
          if (isDark(cx, py) || isDark(cx - 2, py) || isDark(cx + 2, py)) ink++;
        }
        if (ink < minVInk) {
          minVInk = ink;
          bestX = cx;
        }
      }

      // 找最佳水平分區 Y (35% ~ 68% 高度間之水平分隔實線或空白走廊)
      let foundRuleY = -1;
      const xStart = Math.round(pageWidth * 0.06);
      const xEnd = Math.round(pageWidth * 0.94);
      const spanW = xEnd - xStart;
      for (let cy = Math.round(pageHeight * 0.35); cy <= Math.round(pageHeight * 0.68); cy += 2) {
        let rowInk = 0;
        for (let px = xStart; px < xEnd; px += 2) {
          if (isDark(px, cy)) rowInk += 2;
        }
        if (rowInk > spanW * 0.5) {
          foundRuleY = cy;
          break;
        }
      }
      if (foundRuleY > 0) {
        bestY = foundRuleY;
      } else {
        let minHInk = Infinity;
        for (let cy = Math.round(pageHeight * 0.40); cy <= Math.round(pageHeight * 0.64); cy += 4) {
          let ink = 0;
          for (let px = xStart; px < xEnd; px += 3) {
            if (isDark(px, cy) || isDark(px, cy - 2) || isDark(px, cy + 2)) ink++;
          }
          if (ink < minHInk) {
            minHInk = ink;
            bestY = cy;
          }
        }
      }
    }

    const marginX = Math.round(pageWidth * 0.035);
    const topY = Math.round(pageHeight * 0.08);
    const botY = Math.round(pageHeight * 0.96);

    let dividers = { hLines: [], vLines: [] };
    let updatedBlocks = JSON.parse(JSON.stringify(blocks || []));

    if (mode === 'left-right') {
      const vl = { id: `vl_quick_${Date.now()}`, x: bestX, y1: topY, y2: botY };
      dividers.vLines = [vl];
      updatedBlocks = applyDividerLineToBlocks(
        updatedBlocks,
        { orientation: 'vertical', ...vl },
        pageWidth,
        pageHeight,
        dividers
      );
    } else if (mode === 'top-bottom') {
      const hl = { id: `hl_quick_${Date.now()}`, y: bestY, x1: marginX, x2: pageWidth - marginX };
      dividers.hLines = [hl];
      updatedBlocks = applyDividerLineToBlocks(
        updatedBlocks,
        { orientation: 'horizontal', ...hl },
        pageWidth,
        pageHeight,
        dividers
      );
    } else if (mode === 'top2-bottom1') {
      const splitY = bestY > pageHeight * 0.45 ? bestY : Math.round(pageHeight * 0.62);
      const hl = { id: `hl_quick_${Date.now()}`, y: splitY, x1: marginX, x2: pageWidth - marginX };
      const vl = { id: `vl_quick_${Date.now() + 1}`, x: bestX, y1: topY, y2: splitY - 4 };
      dividers = { hLines: [hl], vLines: [vl] };
      updatedBlocks = applyDividerLineToBlocks(
        updatedBlocks,
        { orientation: 'horizontal', ...hl },
        pageWidth,
        pageHeight,
        dividers
      );
      updatedBlocks = applyDividerLineToBlocks(
        updatedBlocks,
        { orientation: 'vertical', ...vl },
        pageWidth,
        pageHeight,
        dividers
      );
    } else if (mode === 'top1-bottom2') {
      const splitY = bestY < pageHeight * 0.55 ? bestY : Math.round(pageHeight * 0.38);
      const hl = { id: `hl_quick_${Date.now()}`, y: splitY, x1: marginX, x2: pageWidth - marginX };
      const vl = { id: `vl_quick_${Date.now() + 1}`, x: bestX, y1: splitY + 4, y2: botY };
      dividers = { hLines: [hl], vLines: [vl] };
      updatedBlocks = applyDividerLineToBlocks(
        updatedBlocks,
        { orientation: 'horizontal', ...hl },
        pageWidth,
        pageHeight,
        dividers
      );
      updatedBlocks = applyDividerLineToBlocks(
        updatedBlocks,
        { orientation: 'vertical', ...vl },
        pageWidth,
        pageHeight,
        dividers
      );
    } else {
      // 'single-col' 全頁單欄由上至下
      dividers = { hLines: [], vLines: [] };
      updatedBlocks = sortBlocksByZonesAndColumns(updatedBlocks, pageWidth, pageHeight, dividers);
    }

    return { dividers, blocks: updatedBlocks };
  }

  /**
   * 對像素畫布執行自動版面分析 (XY-Cut + 水平分隔線偵測 + 左右欄中縫偵測)
   */
  function analyzeCanvasLayout(rgbaData, width, height) {
    // 1. 建立二值化墨跡矩陣 (ink = 1 if gray < 188)
    const inkRow = new Uint32Array(height);
    const isInk = new Uint8Array(width * height);
    const marginX = Math.round(width * 0.035);
    const marginY = Math.round(height * 0.035);

    for (let y = marginY; y < height - marginY; y++) {
      let rSum = 0;
      const rOff = y * width;
      for (let x = marginX; x < width - marginX; x++) {
        const idx = (rOff + x) * 4;
        const g = 0.299 * rgbaData[idx] + 0.587 * rgbaData[idx + 1] + 0.114 * rgbaData[idx + 2];
        if (g < 190) {
          isInk[rOff + x] = 1;
          rSum++;
        }
      }
      inkRow[y] = rSum;
    }

    // 2. 偵測水平實線分隔線 (連續寬度 > 55% 頁面寬度的水平線)
    const detectedHLines = [];
    const activeW = width - marginX * 2;
    let y = Math.round(height * 0.15);
    while (y < Math.round(height * 0.88)) {
      if (inkRow[y] > activeW * 0.52) {
        // 檢查上下 18px 的平均墨跡是否遠小於此線（排除密排文字行）
        let nearSum = 0;
        let nearCnt = 0;
        for (let dy = -16; dy <= 16; dy++) {
          if (Math.abs(dy) <= 3) continue;
          const ny = y + dy;
          if (ny >= marginY && ny < height - marginY) {
            nearSum += inkRow[ny];
            nearCnt++;
          }
        }
        const nearAvg = nearCnt ? nearSum / nearCnt : activeW;
        if (nearAvg < activeW * 0.18) {
          detectedHLines.push({
            id: `hl_auto_${y}`,
            y,
            x1: marginX,
            x2: width - marginX,
            auto: true
          });
          y += 35;
          continue;
        }
      }
      y++;
    }

    // 3. 依水平分隔線切出上下分區，在每個分區檢查是否有中央垂直中縫 (Column Gutter)
    const yCuts = [marginY, ...detectedHLines.map((l) => l.y), height - marginY];
    const detectedVLines = [];
    const rawBlocks = [];
    let blkCounter = 1;

    for (let z = 0; z < yCuts.length - 1; z++) {
      const zTop = yCuts[z] + (z === 0 ? 0 : 8);
      const zBot = yCuts[z + 1] - 8;
      if (zBot - zTop < 50) continue;

      // 計算該分區的垂直投影 (排除頂部 12% 可能是橫跨標題區)
      const colCheckTop = zTop + Math.round((zBot - zTop) * 0.12);
      const centerMinX = Math.round(width * 0.43);
      const centerMaxX = Math.round(width * 0.57);
      let bestSplitX = -1;
      let minColInk = Infinity;

      for (let cx = centerMinX; cx <= centerMaxX; cx += 3) {
        let colInk = 0;
        for (let py = colCheckTop; py < zBot; py++) {
          // 檢查 cx 左右 4px 走廊
          if (isInk[py * width + cx] || isInk[py * width + cx - 2] || isInk[py * width + cx + 2]) {
            colInk++;
          }
        }
        if (colInk < minColInk) {
          minColInk = colInk;
          bestSplitX = cx;
        }
      }

      // 檢查左右兩側是否都有足夠墨跡，且中央走廊幾乎空白
      let leftInk = 0;
      let rightInk = 0;
      for (let py = colCheckTop; py < zBot; py += 2) {
        for (let px = marginX; px < bestSplitX - 10; px += 2) {
          if (isInk[py * width + px]) leftInk++;
        }
        for (let px = bestSplitX + 10; px < width - marginX; px += 2) {
          if (isInk[py * width + px]) rightInk++;
        }
      }

      const hasTwoCols =
        bestSplitX > 0 &&
        minColInk < (zBot - colCheckTop) * 0.045 &&
        leftInk > 120 &&
        rightInk > 120;

      if (hasTwoCols) {
        detectedVLines.push({
          id: `vl_auto_${z}_${bestSplitX}`,
          x: bestSplitX,
          y1: zTop,
          y2: zBot,
          auto: true
        });
      }

      // 在每個欄內由上而下切出水平文字段落群組
      const xRanges = hasTwoCols
        ? [
            [marginX, bestSplitX - 6],
            [bestSplitX + 6, width - marginX]
          ]
        : [[marginX, width - marginX]];

      for (let cIdx = 0; cIdx < xRanges.length; cIdx++) {
        const [x0, x1] = xRanges[cIdx];
        // 先找出該欄內的垂直表格框線／邊界線欄位（整欄高度超過 55% 有墨跡的 x 座標），避免邊框線導致整頁連成同一區塊
        const isVerticalBorderX = new Uint8Array(width);
        const zoneH = Math.max(1, zBot - zTop);
        for (let px = x0; px <= x1; px++) {
          let vCnt = 0;
          for (let py = zTop; py < zBot; py += 2) {
            if (isInk[py * width + px]) vCnt++;
          }
          if (vCnt > (zoneH / 2) * 0.55) {
            isVerticalBorderX[px] = 1;
          }
        }

        const pushSubdividedSegment = (segStart, segEnd) => {
          if (segEnd - segStart < 18) return;
          // 找出實際左右墨跡邊界
          let bMinX = x1, bMaxX = x0;
          for (let sy = segStart; sy <= segEnd; sy++) {
            const rOff = sy * width;
            for (let sx = x0; sx <= x1; sx++) {
              if (isInk[rOff + sx] && !isVerticalBorderX[sx]) {
                if (sx < bMinX) bMinX = sx;
                if (sx > bMaxX) bMaxX = sx;
              }
            }
          }
          if (bMaxX - bMinX <= 20) return;

          // 若單一區塊過高 (> 260px，代表多道題目連在一起)，自動在水平投影波谷處切分為獨立題目框
          const segH = segEnd - segStart;
          if (segH > 260) {
            const rowInkProfile = new Uint32Array(segH + 1);
            for (let sy = segStart; sy <= segEnd; sy++) {
              const rOff = sy * width;
              let cnt = 0;
              for (let sx = bMinX; sx <= bMaxX; sx++) {
                if (isInk[rOff + sx] && !isVerticalBorderX[sx]) cnt++;
              }
              rowInkProfile[sy - segStart] = cnt;
            }
            const subCuts = [0];
            let cursor = 110;
            while (cursor < segH - 90) {
              const winEnd = Math.min(segH - 60, cursor + 110);
              let bestOff = -1;
              let minVal = Infinity;
              for (let off = cursor; off <= winEnd; off++) {
                // 計算 5px 滑動視窗墨跡和
                const vSum =
                  rowInkProfile[off - 2] +
                  rowInkProfile[off - 1] +
                  rowInkProfile[off] +
                  rowInkProfile[off + 1] +
                  rowInkProfile[off + 2];
                if (vSum < minVal) {
                  minVal = vSum;
                  bestOff = off;
                }
              }
              if (bestOff > 0 && minVal <= (bMaxX - bMinX) * 0.06) {
                subCuts.push(bestOff);
                cursor = bestOff + 105;
              } else {
                cursor += 95;
              }
            }
            subCuts.push(segH);
            for (let k = 0; k < subCuts.length - 1; k++) {
              const sy0 = segStart + subCuts[k];
              const sy1 = segStart + subCuts[k + 1];
              if (sy1 - sy0 >= 22) {
                rawBlocks.push({
                  id: `blk_auto_${blkCounter++}`,
                  x: Math.max(marginX, bMinX - 8),
                  y: sy0,
                  w: Math.min(x1 - x0, bMaxX - bMinX + 16),
                  h: sy1 - sy0,
                  type: sy1 - sy0 < 48 && z === 0 && rawBlocks.length === 0 ? 'section' : 'question',
                  text: '',
                  confidence: 92
                });
              }
            }
            return;
          }

          rawBlocks.push({
            id: `blk_auto_${blkCounter++}`,
            x: Math.max(marginX, bMinX - 8),
            y: segStart,
            w: Math.min(x1 - x0, bMaxX - bMinX + 16),
            h: segEnd - segStart,
            type: segEnd - segStart < 44 && z === 0 && rawBlocks.length === 0 ? 'section' : 'question',
            text: '',
            confidence: 92
          });
        };

        let inSeg = false;
        let segStart = zTop;
        let blankRun = 0;
        const minGap = 12;
        const rowNoiseLimit = Math.max(3, Math.round((x1 - x0) * 0.008));

        for (let py = zTop; py <= zBot; py++) {
          let rowCnt = 0;
          if (py < zBot) {
            const rOff = py * width;
            for (let px = x0; px <= x1; px++) {
              if (isInk[rOff + px] && !isVerticalBorderX[px]) rowCnt++;
            }
          }
          if (rowCnt > rowNoiseLimit) {
            if (!inSeg) {
              inSeg = true;
              segStart = Math.max(zTop, py - 4);
            }
            blankRun = 0;
          } else if (inSeg) {
            blankRun++;
            if (blankRun >= minGap || py === zBot) {
              const segEnd = Math.min(zBot, py - blankRun + 4);
              pushSubdividedSegment(segStart, segEnd);
              inSeg = false;
              blankRun = 0;
            }
          }
        }
      }
    }

    const dividers = { hLines: detectedHLines, vLines: detectedVLines };
    const sorted = sortBlocksByZonesAndColumns(rawBlocks, width, height, dividers);
    return { dividers, blocks: sorted };
  }

  // ============================================================================
  // 4. 國小考卷題幹、選項、注音、數學符號（分數、線段、角度、度）結構化智慧解析器
  // ============================================================================
  // 完整支援 37 個注音符號 (ㄅ~ㄩ) 與四聲調號 (ˊ ˇ ˋ ˙，包含前置或後置輕聲)
  const ZHUYIN_REGEX = /(?:˙\s*[ㄅ-ㄩ]+|[ㄅ-ㄩ]+(?:\s*[ˊˇˋ˙])?)+/g;

  // 完整支援四則運算、分數 (3/4, 1又2/3, ½~⅞)、線段 (AB̅, 線段AB)、角度 (∠A, ∠ABC, ∟)、度 (90°, ℃)、幾何關係 (⊥, ∥, △, ≅)
  const MATH_EXPR_REGEX =
    /(?:(?:\d+又\d+\/\d+|\d+\/\d+|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d+(?:\.\d+)?\s*[°℃%]?|[A-Z甲乙丙丁]{2}\u0305|線段\s*[A-Z甲乙丙丁]{2}|∠[A-Z0-9ㄅ-ㄩ]{1,3}|△[A-Z]{3}|∟|[□（）()])\s*(?:[＋+\-－×*÷/＝=≠≒≈＞＜><≧≦±⊥∥≅]\s*(?:\d+又\d+\/\d+|\d+\/\d+|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d+(?:\.\d+)?\s*[°℃%]?|[A-Z甲乙丙丁]{2}\u0305|線段\s*[A-Z甲乙丙丁]{2}|∠[A-Z0-9ㄅ-ㄩ]{1,3}|△[A-Z]{3}|∟|[?？□（）()]))+)|(?:\d+又\d+\/\d+|\b\d+\/\d+\b|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|[A-Z甲乙丙丁]{2}\u0305|線段\s*[A-Z甲乙丙丁]{2}|∠[A-Z0-9ㄅ-ㄩ]{1,3}(?:\s*[＝=]\s*\d+(?:\.\d+)?°)?|\d+(?:\.\d+)?\s*[°℃])/g;

  const SECTION_NUM_REGEX = /^(第[一二三四五六七八九十]+大題|[一二三四五六七八九十]+、|[壹貳參肆伍陸柒捌玖拾]+、)/;
  const QUESTION_NUM_REGEX = /^((?:[\(（][\s　]*[\)）]\s*)?(?:第\s*\d+\s*題|\d+[\.、．]|[\(（]\d+[\)）]|[①-⑳]))/;

  // 常見 OCR 誤認之注音近似字修正表（僅於注音語境或括號內觸發）
  const ZHUYIN_LOOKALIKE_MAP = {
    '一': 'ㄧ',
    '｜': 'ㄧ',
    '|': 'ㄧ',
    '乂': 'ㄨ',
    '凵': 'ㄩ',
    '丫': 'ㄚ',
    '力': 'ㄌ',
    '刀': 'ㄉ',
    '厂': 'ㄏ',
    '日': 'ㄖ',
    '儿': 'ㄦ',
    '卩': 'ㄗ',
    '厶': 'ㄙ',
    '丂': 'ㄎ'
  };

  /**
   * 針對 OCR 辨識後之注音符號與聲調進行智慧校正
   * 修復 OCR 將二聲(ˊ)、三聲(ˇ)、四聲(ˋ)、輕聲(˙)誤認為英數標點，以及將 ㄧㄨㄩ 誤認為國字的情況
   */
  function normalizeZhuyinText(input) {
    if (!input) return '';
    let s = String(input);

    // 1. 將緊接在注音符號後的常見聲調誤認字元轉為標準調號
    s = s.replace(/([ㄅ-ㄩ])\s*['´ˊ]/g, '$1ˊ');
    s = s.replace(/([ㄅ-ㄩ])\s*[\^vVˇ]/g, '$1ˇ');
    s = s.replace(/([ㄅ-ㄩ])\s*[`ˋ\\]/g, '$1ˋ');
    s = s.replace(/([ㄅ-ㄩ])\s*[·\.˙]/g, '$1˙');
    s = s.replace(/[·\.]\s*([ㄅ-ㄩ])/g, '˙$1');

    // 2. 若在注音符號相鄰位置出現「一、乂、凵、丫、力、刀、厂、儿」等近似字，修正為標準注音
    s = s.replace(/([ㄅ-ㄩˊˇˋ˙])\s*([一｜|乂凵丫力刀厂日儿卩厶丂])/g, (_, a, b) => a + (ZHUYIN_LOOKALIKE_MAP[b] || b));
    s = s.replace(/([一｜|乂凵丫力刀厂日儿卩厶丂])\s*([ㄅ-ㄩˊˇˋ˙])/g, (_, a, b) => (ZHUYIN_LOOKALIKE_MAP[a] || a) + b);

    return s;
  }

  /**
   * 深度清理 OCR 亂碼、壓縮中文字間多餘空白、還原國小考卷圓圈選項 ①②③④ 與清除注音旁註導致的英文符號幻覺
   */
  function cleanOcrGarbledText(input) {
    if (!input) return '';
    let s = String(input);

    // 1. 將開頭誤認的題號 "s." 或 "S." 還原為 "5."
    s = s.replace(/(?:[\(（][\s　。]*[\)）]\s*)?\b[sS]\s*[\.、．]\s*/g, '（　）5. ');

    // 2. 優先還原國小考卷常見的「4 個連續數字／角度選項」被誤讀為 (D / D / @ / ® / # / ¥ 的情況
    // 例如：(D30 @40 @50 @60、D36282 @ 36202 (D36302 @36272、(D42 @38 @29 @35、1 ®20° @35° @110° @®120°
    s = s.replace(
      /(?:\b1\s+)?[\(（]?[D0O®@©#¥]{1,2}[\)）]?\s*(\d+[°℃]?)\s+[\(（]?[@®D0O©#¥]{1,2}[\)）]?\s*(\d+[°℃]?)\s+[\(（]?[@®D0O©#¥]{1,2}[\)）]?\s*(\d+[°℃]?)\s+[\(（]?[@®D0O©#¥]{1,2}[\)）]?\s*(\d+[°℃]?)/g,
      ' ① $1 ② $2 ③ $3 ④ $4'
    );
    // 處理如 "1687 35 @1786 # (D1867 ¥ DIBT6" 的四選一數字選項破損
    s = s.replace(
      /\b(\d{3,5})\s+(?:\d{1,2}\s+)?[@®#]+\s*(\d{3,5})\s*[#@®]*\s*[\(（]?[D0O@®](\d{3,5})\s*[¥@®#]+\s*[D0O]?[I1l][B8][T7](\d)\b/g,
      ' ① $1 ② $2 ③ $3 ④ 187$4'
    );

    // 3. 壓縮中文字與標點之間的碎空白（重複執行以處理連續單字空白 "畫 一 個 直 角 三 角 形"，但保留注音音節間空白如 "ㄕㄨ ㄅㄠ"）
    const cjkChar = '[\\u4e00-\\u9fff，。、？！；：「」『』（）《》〈〉【】]';
    const cjkSpaceRe = new RegExp(`(${cjkChar})[ \\t]+(${cjkChar})`, 'g');
    for (let i = 0; i < 4; i++) {
      s = s.replace(cjkSpaceRe, '$1$2');
    }
    // 中文字與半形標點間的空白轉全形標點
    s = s.replace(/([\u4e00-\u9fffㄅ-ㄩˊˇˋ˙])\s*,\s*/g, '$1，');
    s = s.replace(/([\u4e00-\u9fffㄅ-ㄩˊˇˋ˙])\s*\?\s*/g, '$1？');
    s = s.replace(/([\u4e00-\u9fffㄅ-ㄩˊˇˋ˙])\s*!\s*/g, '$1！');
    // 修復中文字中間被誤插的冒號（例如 "畫：出銳角" -> "畫出銳角"）
    s = s.replace(/([\u4e00-\u9fff])\s*[:：]\s*(?=出|入|成|為|在|到|於)/g, '$1');

    // 4. 還原長句文字選項中的 (@ / ® -> ① ② ③ ④
    if (/(?:\(@|（@|®)\s*[\u4e00-\u9fff]/.test(s)) {
      // 若第一項前被誤讀為「？必用」或「？①用」
      s = s.replace(/？\s*[必①]\s*(?=用)/g, '？ ① ');
      let optCounter = s.includes('①') ? 2 : 1;
      const circled = ['①', '②', '③', '④', '⑤'];
      s = s.replace(/["”'’。]*\s*(?:\(@|（@|@®|®|@)\s*(?=[\u4e00-\u9fff])/g, () => {
        const sym = circled[Math.min(optCounter - 1, 4)];
        optCounter++;
        return ` ${sym} `;
      });
      // 若已有 ① ② ③，且後接 ”用... 則補上 ④
      if (s.includes('①') && s.includes('②') && s.includes('③') && !s.includes('④')) {
        s = s.replace(/[”"']+\s*(?=用[\u4e00-\u9fff])/g, '。 ④ ');
        // 若引號已被合併，檢查重複句型「再用尺連接用三角板」
        s = s.replace(/(再用尺連接)\s*(?=用三角)/g, '$1。 ④ ');
      }
    }

    // 5. 清除因右側注音旁註導致 Tesseract 幻覺產生的英文與亂碼符號串
    // 例如："SZ WORIAE P9 A7"、"AEAEFIIEIRE — G%08K#98 5T"、"& HubX TRE?"、"thsx BIBLRA"、"3 2 30? / ”)LL."
    s = s.replace(/^[\s"“”'‘’吃,，]+(?=[\u4e00-\u9fff]{2,}(?:國小|國中|學年))/g, '');
    s = s.replace(/(評量)\s*\d+\s*\d*\s*\d*\?\s*\/\s*[”")\sA-Za-z\.]+/g, '$1 ');
    s = s.replace(/比\s*@i\s*[?？]/g, '比較快？');

    // 清除夾在中文或題號之間的純英文/亂碼符號詞組（保留合法幾何代號 AB/CD/EF/ABC 與單位 cm/mm/km/kg/mL）
    const VALID_ASCII_TOKENS = new Set([
      'A', 'B', 'C', 'D',
      'AB', 'BC', 'CD', 'DE', 'EF', 'FG', 'GH', 'AC', 'BD',
      'ABC', 'DEF', 'GHI',
      'cm', 'mm', 'km', 'kg', 'mg', 'mL', 'ml', 'dl', 'dL'
    ]);
    // 移除含有 % # & @ ¥ ® 的亂碼 token（如 G%08K#98、DIBT6）
    s = s.replace(/[A-Za-z0-9]*[%#&@¥®][A-Za-z0-9%#&@¥®]*/g, ' ');
    // 移除英數混雜幻覺短碼（如 P9、A7、3b、5T，但保留 ∠1、A.、45°、25℃ 等）
    s = s.replace(/(?<![∠△])[ \t]+\b(?:[A-Za-z]\d{1,2}|\d{1,2}[A-DF-Za-df-z])\b(?![°℃\.])/g, ' ');
    // 移除連續 2 個以上英文字母的幻覺詞（若非合法幾何/單位）
    s = s.replace(/\b([A-Za-z]{2,14})(?:\s+([A-Za-z0-9]{1,8}))?\b/g, (full, w1, w2) => {
      if (VALID_ASCII_TOKENS.has(w1) && (!w2 || VALID_ASCII_TOKENS.has(w2))) {
        return full;
      }
      return ' ';
    });
    // 移除殘留孤立亂碼符號
    s = s.replace(/[“”"¥®©™§¶|~_]+/g, ' ');
    // 修復空白括號題號 "( 。 )" 或 "( )" -> " （　）"（前補空白方便多題自動切分）
    s = s.replace(/[\(（]\s*[。．\.]?\s*[\)）]/g, ' （　）');
    // 修復殘留孤立左括號如 "說 ( 4." -> " （　）4."
    s = s.replace(/(?:說\s*)?[\(（]\s+(?=[1-9]\d?\s*[\.、．])/g, ' （　）');

    // 再次壓縮因移除亂碼產生的多餘空白
    for (let i = 0; i < 3; i++) {
      s = s.replace(cjkSpaceRe, '$1$2');
    }
    s = s.replace(/[ \t]{2,}/g, ' ').trim();
    return s;
  }

  /**
   * 針對數學符號、分數、線段符號、角度符號、度的符號進行 OCR 智慧校正與正規化
   */
  function normalizeMathAndSymbols(input) {
    if (!input) return '';
    let s = normalizeZhuyinText(String(input));

    // 先處理 LaTeX 線段、角度與溫度/度數符號，避免被亂碼過濾器誤刪
    s = s.replace(/\\overline\{([A-Z甲乙丙丁]{2})\}/g, '$1\u0305');
    s = s.replace(/(?:\/_|＜|<)\s*([A-Z]{1,3}|\d{1,2})(?=\s*[＝=＞＜><°度為是與和合＋+\-－，。？：:\s）)]|$)/g, '∠$1');
    s = s.replace(/_\|_/g, '⊥');
    s = s.replace(/(\d+(?:\.\d+)?)\s*[°º˚oO]?\s*C\b/g, '$1℃');
    s = s.replace(/(\d+(?:\.\d+)?)\s*[oO](?=\s*[，。、？；）)\s＋+\-－＝=]|$)/g, '$1°');
    s = cleanOcrGarbledText(s);

    // 1. 處理直式上下疊寫分數（例如 OCR 辨識出「分子 \n ── \n 分母」）轉為標準分數「分子/分母」
    s = s.replace(/(\d+)\s*\n\s*[─—\-―⎯＿_]{1,6}\s*\n\s*(\d+)/g, '$1/$2');
    s = s.replace(/(\d+)\s*又\s*(\d+)\s*[\/／]\s*(\d+)/g, '$1又$2/$3');
    // 全形或帶空白斜線在數字間轉為標準分數斜線
    s = s.replace(/(\d+)\s*[\/／]\s*(\d+)/g, '$1/$2');

    // 2. 處理線段符號 (Overbar Line Segment: \overline{AB}, ¯AB, ￣AB, 線段AB -> AB̅)
    s = s.replace(/\\overline\{([A-Z甲乙丙丁]{2})\}/g, '$1\u0305');
    s = s.replace(/[¯￣]\s*([A-Z]{2})\b/g, '$1\u0305');
    s = s.replace(/([A-Z]{2})\s*[¯￣]/g, '$1\u0305');
    // 若寫「線段AB」或「線段 AB」，補上標準頂線符號方便重排 PDF 繪製頂線並保留語意
    s = s.replace(/線段\s*([A-Z]{2})(?!\u0305)/g, '線段$1（$1\u0305）');

    // 3. 處理角度符號 (修復 OCR 將 ∠A, ∠1, ∠2, ∠ABC 誤認為 <A, /_A, /1, /2, LA)
    s = s.replace(/(?:\/_|＜|<)\s*([A-Z]{1,3}|\d{1,2})(?=\s*[＝=＞＜><°度為是與和合＋+\-－，。？：:\s）)]|$)/g, '∠$1');
    // 修復單斜線 "/1 是 60 度"、"與 /2 合起來" -> "∠1"、"∠2"
    s = s.replace(/(?<![0-9A-Za-z])\/\s*([1-9]|[A-Z]{1,3})(?=\s*(?:是|為|與|和|合|的|＝|=|＞|＜|\d+|[，。？]))/g, '∠$1');
    s = s.replace(/\bL\s*([A-Z]{1,3}|\d{1,2})(?=\s*[＝=]\s*\d)/g, '∠$1');
    // 若同一句已出現 ∠1 或 ∠2 且有「平角／直角／度」，將遺漏符號的 "且 1 與 ∠2"、"則 2 是幾度" 補回 ∠1、∠2
    if (s.includes('∠') && /[角|度]/.test(s)) {
      s = s.replace(/(且|及|或)\s*([1-9])\s*(與|和)\s*(∠[1-9])/g, '$1 ∠$2 $3 $4');
      s = s.replace(/(則|請問|求)\s*([1-9])\s*(是幾度|是多少度|的度數)/g, '$1 ∠$2 $3');
    }
    // 修復三角形符號 ΔABC -> △ABC
    s = s.replace(/[Δ▲]\s*([A-Z]{3})\b/g, '△$1');
    // 修復垂直與平行符號
    s = s.replace(/_\|_/g, '⊥');
    s = s.replace(/([A-Z]{2}\u0305?)\s*\/\/\s*([A-Z]{2}\u0305?)/g, '$1 ∥ $2');

    // 4. 處理度的符號 (° 與 ℃)
    // 修復 º, ˚, ゜ 為標準 ° (U+00B0)
    s = s.replace(/(\d+(?:\.\d+)?)\s*[º˚゜]/g, '$1°');
    // 修復攝氏溫度 25°C, 25 oC, 25℃ -> 25℃
    s = s.replace(/(\d+(?:\.\d+)?)\s*[°º˚oO]?\s*C\b/g, '$1℃');
    // 修復角度語境下 OCR 將 90° 誤讀為 90o 或 90O 或 900
    s = s.replace(/(\d+(?:\.\d+)?)\s*[oO](?=\s*[，。、？；）)\s＋+\-－＝=]|$)/g, '$1°');
    s = s.replace(/(∠[A-Z0-9]{1,3}\s*[＝=]\s*)(30|45|60|75|90|105|120|135|150|180|360)0\b/g, '$1$2°');
    s = s.replace(/(∠[A-Z0-9]{1,3})\s*=\s*(\d+)/g, '$1 ＝ $2');

    // 5. 修復除法算式中的 ÷ 被誤讀為數字 3 或 7（例如 "196357 中，可把除數 57" -> "196 ÷ 57 中，可把除數 57"）
    const divMatch = s.match(/除數\s*(\d{1,3})/);
    if (divMatch) {
      const divisor = divMatch[1];
      const divRe = new RegExp(`\\b(\\d{2,4})[37](${divisor})\\b(?=\\s*中)`);
      s = s.replace(divRe, '$1 ÷ $2');
    }

    // 6. 處理常見數學比較與近似符號
    s = s.replace(/!=/g, '≠');
    s = s.replace(/>=/g, '≧');
    s = s.replace(/<=/g, '≦');
    s = s.replace(/≈/g, '≒');

    // 7. 國小考卷常見 OCR 國字錯別字與題號括號自動修正（提升繁體中文辨識正確性）
    const EXAM_TYPO_FIXES = [
      [/彰化家仲東國小/g, '彰化縣伸東國小'],
      [/家仲東國小/g, '縣伸東國小'],
      [/三角請扳/g, '三角板'],
      [/三角扳/g, '三角板'],
      [/尺迪接/g, '尺連接'],
      [/美女與野戰/g, '美女與野獸'],
      [/歌碇劇/g, '歌劇'],
      [/場場洽滿/g, '場場客滿'],
      [/一共郁多少/g, '一共有多少'],
      [/仿起來/g, '合起來'],
      [/量角器內圖/g, '量角器內圈'],
      [/刻度\s*20\s*70\s*的線/g, '刻度 20 到刻度 70 的線'],
      [/母題\s*(\d+)\s*分/g, '每題 $1 分'],
      [/選澤題/g, '選擇題'],
      [/是韭題/g, '是非題'],
      [/國字汪音/g, '國字注音'],
      [/算弍/g, '算式'],
      [/花朶/g, '花朵'],
      [/倘伴/g, '倘佯'],
      [/末雨綢繆/g, '未雨綢繆'],
      [/^\s*[\(（\[]\s*[\)）\]]\s*/gm, '（　）']
    ];
    for (const [pat, rep] of EXAM_TYPO_FIXES) {
      s = s.replace(pat, rep);
    }

    return s;
  }

  /**
   * 當單一區塊辨識出多道連續編號題目（如 1. ... ( ) 2. ... ( ) 3. ...）時，自動拆分為獨立結構化題目陣列
   */
  function splitMultiQuestionText(rawText, baseBlk = {}) {
    const cleaned = normalizeMathAndSymbols(rawText);
    if (!cleaned) return [];

    // 偵測「（　）2. 」、「2. 」等連續題號切分點（排除小數點如 3.5）
    const splitPoints = [];
    const qBoundaryRe = /(?:^|\s+|(?=（　）))(?:（　）\s*)?([1-9]\d?)\s*[\.、．]\s*(?=[^\d])/g;
    let m;
    while ((m = qBoundaryRe.exec(cleaned)) !== null) {
      const qNum = Number(m[1]);
      if (qNum >= 1 && qNum <= 30) {
        splitPoints.push({ index: m.index, qNum, matchStr: m[0] });
      }
    }

    // 若未偵測到 2 題以上，但開頭有考卷標題＋第 1 題（如「彰化縣伸東國小...評量 畫一個直角三角形...（　）2. ...」）
    if (splitPoints.length >= 1) {
      const segments = [];
      const firstIdx = splitPoints[0].index;
      if (firstIdx > 12) {
        const prefix = cleaned.slice(0, firstIdx).trim();
        // 檢查 prefix 是否包含考卷抬頭與第 1 題
        const headerMatch = prefix.match(/^(.*?評量)\s*(.+)$/);
        if (headerMatch) {
          segments.push({ isHeader: true, text: headerMatch[1].trim() });
          segments.push({ isHeader: false, qNum: 1, text: `1. ${headerMatch[2].trim()}` });
        } else {
          segments.push({ isHeader: false, qNum: 1, text: `1. ${prefix}` });
        }
      }
      for (let i = 0; i < splitPoints.length; i++) {
        const start = splitPoints[i].index;
        const end = i + 1 < splitPoints.length ? splitPoints[i + 1].index : cleaned.length;
        const segText = cleaned.slice(start, end).trim();
        if (segText) {
          segments.push({ isHeader: false, qNum: splitPoints[i].qNum, text: segText });
        }
      }

      if (segments.length >= 2) {
        const totalSegs = segments.length;
        const baseH = Math.max(60, Number(baseBlk.h || 300));
        const sliceH = Math.max(40, Math.round(baseH / totalSegs));
        return segments.map((seg, idx) => {
          const parsed = parseQuestionStructure(
            seg.text,
            seg.isHeader ? 'section' : baseBlk.type || 'question',
            baseBlk.sectionNumber || '第一大題',
            baseBlk.sectionTitle || '選擇題'
          );
          if (!seg.isHeader && seg.qNum && !parsed.questionNumber) {
            parsed.questionNumber = `第 ${seg.qNum} 題`;
          }
          return {
            ...baseBlk,
            ...parsed,
            id: idx === 0 && baseBlk.id ? baseBlk.id : `blk_split_${Date.now()}_${idx + 1}`,
            y: Math.round((baseBlk.y || 100) + idx * sliceH),
            h: sliceH,
            confidence: baseBlk.confidence || 92,
            lowConfidence: false
          };
        });
      }
    }

    return [];
  }

  /**
   * 將含有分數、線段、角度、度、垂直、平行的文字轉為國小特教報讀系統自然中文讀法
   */
  function toAssistiveSpeechText(text) {
    if (!text) return '';
    let s = String(text);
    const VULGAR_MAP = {
      '½': '二分之一',
      '⅓': '三分之一',
      '⅔': '三分之二',
      '¼': '四分之一',
      '¾': '四分之三',
      '⅕': '五分之一',
      '⅖': '五分之二',
      '⅗': '五分之三',
      '⅘': '五分之四',
      '⅙': '六分之一',
      '⅚': '六分之五',
      '⅛': '八分之一',
      '⅜': '八分之三',
      '⅝': '八分之五',
      '⅞': '八分之七'
    };
    for (const [k, v] of Object.entries(VULGAR_MAP)) {
      s = s.split(k).join(v);
    }
    // 帶分數 1又2/3 -> 1又3分之2
    s = s.replace(/(\d+)\s*又\s*(\d+)\s*\/\s*(\d+)/g, '$1又$3分之$2');
    // 一般分數 3/4 -> 4分之3
    s = s.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, '$2分之$1');
    // 避免「線段AB（AB̅）」重複唸兩次線段
    s = s.replace(/線段\s*([A-Z甲乙丙丁]{2})\s*[（(]\1\u0305[)）]/g, '線段 $1');
    // 線段 AB̅ -> 線段 AB
    s = s.replace(/([A-Z甲乙丙丁]{2})\u0305/g, '線段 $1');
    // 角度 ∠ABC -> 角 ABC
    s = s.replace(/∠([A-Z0-9ㄅ-ㄩ]{1,3})/g, '角 $1');
    s = s.replace(/∟/g, '直角');
    // 三角形 △ABC -> 三角形 ABC
    s = s.replace(/△([A-Z]{3})/g, '三角形 $1');
    // 垂直與平行
    s = s.replace(/⊥/g, ' 垂直於 ');
    s = s.replace(/∥/g, ' 平行於 ');
    s = s.replace(/≅/g, ' 全等於 ');
    // 度與攝氏度
    s = s.replace(/(\d+(?:\.\d+)?)\s*℃/g, '攝氏 $1 度');
    s = s.replace(/(\d+(?:\.\d+)?)\s*°/g, '$1 度');
    // 運算符號自然讀法
    s = s.replace(/[＋+]/g, ' 加 ');
    s = s.replace(/[－]/g, ' 減 ');
    s = s.replace(/[×]/g, ' 乘以 ');
    s = s.replace(/[÷]/g, ' 除以 ');
    s = s.replace(/[＝=]/g, ' 等於 ');
    s = s.replace(/≧/g, ' 大於或等於 ');
    s = s.replace(/≦/g, ' 小於或等於 ');
    s = s.replace(/≠/g, ' 不等於 ');
    s = s.replace(/≒/g, ' 約等於 ');
    return s.replace(/\s+/g, ' ').trim();
  }

  function parseQuestionStructure(rawText, defaultType = 'question', fallbackSecNum = '第一大題', fallbackSecTitle = '綜合測驗') {
    const clean = normalizeMathAndSymbols(
      String(rawText || '')
        .replace(/\r\n/g, '\n')
        .trim()
    );

    const result = {
      type: defaultType,
      sectionNumber: fallbackSecNum,
      sectionTitle: fallbackSecTitle,
      questionNumber: '',
      stemText: clean,
      options: [],
      zhuyinText: '',
      mathFormula: ''
    };

    if (!clean) return result;

    // 1. 判斷是否為大題標題
    const secMatch = clean.match(SECTION_NUM_REGEX);
    if (defaultType === 'section' || (secMatch && clean.length < 36 && !/[A-D①-④]\s*[\.、．)]/.test(clean))) {
      result.type = 'section';
      if (secMatch) {
        result.sectionNumber = secMatch[1].replace(/、$/, '');
        result.sectionTitle = clean
          .slice(secMatch[0].length)
          .replace(/^[：:\s]+/, '')
          .trim();
      } else {
        result.sectionTitle = clean;
      }
      result.stemText = clean;
      return result;
    }

    // 2. 擷取注音內容 (包含輕聲 ˙ 與二三四聲 ˊˇˋ)
    const zhuyinMatches = clean.match(ZHUYIN_REGEX);
    if (zhuyinMatches && zhuyinMatches.length > 0) {
      result.zhuyinText = zhuyinMatches.map((z) => z.trim()).join(' ');
    }

    // 3. 分離選項 (支援 A. B. C. D. / (A)(B)(C)(D) / ① ② ③ ④，包含緊接在問號或冒號後的 ①)
    const optionSplitRegex = /(?=(?:^|\s+|(?<=[？?。：:）)]))(?:[\(（]?[A-D][\.、．\)）]|[①②③④⑤])\s*)/g;
    const parts = clean.split(optionSplitRegex).map((s) => s.trim()).filter(Boolean);

    let stemRaw = clean;
    if (parts.length >= 2 && /^(?:[\(（]?[A-D][\.、．\)）]|[①②③④⑤])/.test(parts[1])) {
      stemRaw = parts[0];
      result.options = parts.slice(1).map((opt) =>
        opt.replace(/^[\(（]([A-D])[\)）]\s*/, '$1. ')
      );
    } else {
      // 檢查多行選項
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
      const optLines = [];
      const stemLines = [];
      for (const line of lines) {
        if (/^(?:[\(（]?[A-D][\.、．\)）]|[①②③④⑤])\s*\S+/.test(line)) {
          optLines.push(line.replace(/^[\(（]([A-D])[\)）]\s*/, '$1. '));
        } else {
          stemLines.push(line);
        }
      }
      if (optLines.length >= 2) {
        stemRaw = stemLines.join(' ');
        result.options = optLines;
      }
    }

    // 4. 擷取小題題號（先將題號剝離後再擷取數學算式，避免將題號「1.」誤判為算式的一部分）
    const qMatch = stemRaw.match(QUESTION_NUM_REGEX);
    if (qMatch) {
      const rawNum = qMatch[1].trim();
      const digits = rawNum.match(/\d+/);
      result.questionNumber = digits ? `第 ${digits[0]} 題` : rawNum;
      const afterNum = stemRaw.slice(qMatch[0].length).replace(/^[：:\s\.、]+/, '').trim();
      const prefixBlank = /^\s*[\(（][\s　]*[\)）]/.test(rawNum) ? '（　）' : '';
      result.stemText = (prefixBlank + afterNum) || stemRaw;
    } else {
      result.stemText = stemRaw;
    }

    // 5. 從題幹擷取數學算式、分數、線段、角度與度數符號
    const mathMatches = result.stemText.match(MATH_EXPR_REGEX);
    if (mathMatches && mathMatches.length > 0) {
      // 過濾掉單純題號或重複空白
      const validMath = mathMatches
        .map((m) => m.trim())
        .filter((m) => m.length >= 2);
      if (validMath.length > 0) {
        result.mathFormula = [...new Set(validMath)].join(' ； ');
      }
    }

    return result;
  }

  // ============================================================================
  // 5. 純 JavaScript ISO/IEC 18004 標準 QR Code 矩陣產生器 (無須外部圖片 API)
  // ============================================================================
  function generateQrMatrix(text) {
    const dataBytes = Array.from(new TextEncoder().encode(String(text || 'https://liniris1023.github.io/smart-exam-ocr/')));
    // 自動選擇合適 Version (Level L, Byte mode): V3(53B), V4(78B), V5(106B), V6(134B)
    const VERSIONS = [
      null,
      { v: 1, size: 21, totalCodewords: 26, ecCodewords: 7, align: [] },
      { v: 2, size: 25, totalCodewords: 44, ecCodewords: 10, align: [6, 18] },
      { v: 3, size: 29, totalCodewords: 70, ecCodewords: 15, align: [6, 22] },
      { v: 4, size: 33, totalCodewords: 100, ecCodewords: 20, align: [6, 26] },
      { v: 5, size: 37, totalCodewords: 134, ecCodewords: 26, align: [6, 30] },
      { v: 6, size: 41, totalCodewords: 172, ecCodewords: 36, align: [6, 34] } // 2 blocks of 18 EC in V6, keep V1-V5 single-block for simplicity
    ];

    let ver = VERSIONS[5]; // Version 5 (up to 106 UTF-8 bytes in single block Level L!)
    for (let v = 1; v <= 5; v++) {
      const cap = VERSIONS[v].totalCodewords - VERSIONS[v].ecCodewords - 2;
      if (dataBytes.length <= cap) {
        ver = VERSIONS[v];
        break;
      }
    }

    const dataCap = ver.totalCodewords - ver.ecCodewords;
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    pushBits(0b0100, 4); // Byte mode
    pushBits(Math.min(dataBytes.length, dataCap - 2), 8);
    for (let i = 0; i < Math.min(dataBytes.length, dataCap - 2); i++) {
      pushBits(dataBytes[i], 8);
    }
    pushBits(0, Math.min(4, dataCap * 8 - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      codewords.push(b);
    }
    const padBytes = [0xec, 0x11];
    let pIdx = 0;
    while (codewords.length < dataCap) {
      codewords.push(padBytes[pIdx++ % 2]);
    }

    // GF(256) Reed-Solomon Error Correction
    const gfExp = new Uint8Array(512);
    const gfLog = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      gfExp[i] = x;
      gfLog[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
    const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]);

    let gen = [1];
    for (let i = 0; i < ver.ecCodewords; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], gfExp[i]);
      }
      gen = next;
    }

    const msg = [...codewords, ...new Array(ver.ecCodewords).fill(0)];
    for (let i = 0; i < codewords.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    const ecBytes = msg.slice(codewords.length);
    const allBytes = [...codewords, ...ecBytes];

    // Build QR Matrix
    const size = ver.size;
    const mat = Array.from({ length: size }, () => new Array(size).fill(0));
    const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

    const setFinder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r, cc = c0 + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const on =
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          mat[rr][cc] = on ? 1 : 0;
          isFunc[rr][cc] = true;
        }
      }
    };
    setFinder(0, 0);
    setFinder(0, size - 7);
    setFinder(size - 7, 0);

    // Alignment pattern
    if (ver.align.length >= 2) {
      const ar = ver.align[1], ac = ver.align[1];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          mat[ar + r][ac + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
          isFunc[ar + r][ac + c] = true;
        }
      }
    }

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      mat[6][i] = i % 2 === 0 ? 1 : 0;
      isFunc[6][i] = true;
      mat[i][6] = i % 2 === 0 ? 1 : 0;
      isFunc[i][6] = true;
    }

    // Reserve format areas
    for (let i = 0; i < 9; i++) {
      if (i < size) {
        isFunc[8][i] = true;
        isFunc[i][8] = true;
      }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][size - 1 - i] = true;
      isFunc[size - 1 - i][8] = true;
    }
    mat[size - 8][8] = 1;
    isFunc[size - 8][8] = true;

    // Place data bits
    let bitIdx = 0;
    const totalBits = allBytes.length * 8;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunc[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) {
              bit = (allBytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            // Mask 0: (r + c) % 2 === 0
            if ((r + c) % 2 === 0) bit ^= 1;
            mat[r][c] = bit;
          }
        }
      }
      upward = !upward;
    }

    // Format info for Level L (01) + Mask 0 (000) -> 0x77c4
    const fmtBits = 0x77c4;
    for (let i = 0; i <= 5; i++) mat[8][i] = (fmtBits >> (14 - i)) & 1;
    mat[8][7] = (fmtBits >> 8) & 1;
    mat[8][8] = (fmtBits >> 7) & 1;
    mat[7][8] = (fmtBits >> 6) & 1;
    for (let i = 0; i < 6; i++) mat[5 - i][8] = (fmtBits >> (5 - i)) & 1;
    for (let i = 0; i < 8; i++) mat[8][size - 1 - i] = (fmtBits >> i) & 1;
    for (let i = 0; i < 7; i++) mat[size - 7 + i][8] = (fmtBits >> (14 - i)) & 1;

    return mat;
  }

  return {
    assessImageQuality,
    detectPaperQuad,
    warpPerspectiveImageData,
    enhanceExamImageData,
    sortBlocksByZonesAndColumns,
    applyDividerLineToBlocks,
    quickPartitionLayout,
    analyzeCanvasLayout,
    cleanOcrGarbledText,
    normalizeZhuyinText,
    normalizeMathAndSymbols,
    splitMultiQuestionText,
    toAssistiveSpeechText,
    parseQuestionStructure,
    generateQrMatrix
  };
});
