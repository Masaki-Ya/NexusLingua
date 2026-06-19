import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Mode = "translate" | "summarize" | "explain";

function App() {
  const [windowLabel, setWindowLabel] = useState("main");
  const [modelName, setModelName] = useState(() => localStorage.getItem("gemini_model_name") || "gemini-1.5-flash");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [sourceText, setSourceText] = useState("");
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [translatedText, setTranslatedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("translate");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [showSettings, setShowSettings] = useState(false);
  const [keyInput, setKeyInput] = useState(apiKey);
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    const win = getCurrentWindow();
    setWindowLabel(win.label);
  }, []);

  // APIキー変更時に使用可能なモデル一覧を取得
  useEffect(() => {
    if (windowLabel === "main" && apiKey) {
      fetchModels(apiKey);
    }
  }, [windowLabel, apiKey]);

  useEffect(() => {
    if (windowLabel !== "main") return;

    // Rust側からのテキスト選択イベントを監視
    const unlistenText = listen<string>("text-selected", (event) => {
      const text = event.payload;
      setCapturedImage(null); // 画像をクリア
      setSourceText(text);
      if (text.trim()) {
        executeAiAction(text, mode);
      }
    });

    // キャプチャウィンドウからの画像選択イベントを監視
    const unlistenImage = listen<string>("image-captured", (event) => {
      const base64Img = event.payload;
      setSourceText(""); // テキストをクリア
      setCapturedImage(base64Img);
      executeImageAction(base64Img, mode);
    });

    return () => {
      unlistenText.then((f) => f());
      unlistenImage.then((f) => f());
    };
  }, [windowLabel, mode, apiKey]);

  const fetchModels = async (key: string) => {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      const data = await response.json();
      
      // generateContent をサポートするモデルを抽出
      const models = data.models
        ?.filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
        ?.map((m: any) => m.name.replace("models/", "")) || [];
      
      if (models.length > 0) {
        setAvailableModels(models);
        // 現在選択中のモデルが一覧にない場合は、最初のモデルを自動選択
        const currentStored = localStorage.getItem("gemini_model_name") || "";
        if (!models.includes(currentStored) && !models.includes(modelName)) {
          setModelName(models[0]);
          localStorage.setItem("gemini_model_name", models[0]);
        } else if (models.includes(currentStored) && modelName !== currentStored) {
          setModelName(currentStored);
        }
      } else {
        // フォールバック
        setAvailableModels(["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"]);
      }
    } catch (err) {
      console.error("Error fetching models:", err);
      // エラー時のフォールバック
      setAvailableModels(["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"]);
    }
  };

  const saveApiKey = () => {
    const trimmed = keyInput.trim();
    localStorage.setItem("gemini_api_key", trimmed);
    setApiKey(trimmed);
    setKeyInput(trimmed);
    fetchModels(trimmed); // 新しいキーでモデル一覧を再取得
    setShowSettings(false);
    setStatusMsg("APIキーを保存しました");
    setTimeout(() => setStatusMsg(""), 3000);
  };

  const executeAiAction = async (text: string, currentMode: Mode) => {
    if (!apiKey) {
      setTranslatedText("エラー: APIキーが設定されていません。右上の設定アイコンからGemini APIキーを設定してください。");
      return;
    }

    setLoading(true);
    setTranslatedText("AIが考え中...");

    let prompt = "";
    if (currentMode === "translate") {
      prompt = `以下の文章を自然な日本語に翻訳してください。翻訳結果のみを出力してください。\n\n${text}`;
    } else if (currentMode === "summarize") {
      prompt = `以下の文章を分かりやすく箇条書きで日本語に要約してください。\n\n${text}`;
    } else if (currentMode === "explain") {
      prompt = `以下の文章や単語、プログラミングコードについて、日本語で詳しく解説してください。\n\n${text}`;
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }],
              },
            ],
          }),
        }
      );

      if (!response.ok) {
        let details = "";
        try {
          const errJson = await response.json();
          details = errJson.error?.message || response.statusText;
        } catch {
          details = response.statusText;
        }
        throw new Error(`HTTP error! status: ${response.status} (${details})`);
      }

      const data = await response.json();
      const resultText =
        data.candidates?.[0]?.content?.parts?.[0]?.text || "エラー: 翻訳結果を取得できませんでした。";
      setTranslatedText(resultText);
    } catch (error: any) {
      console.error(error);
      setTranslatedText(`エラーが発生しました: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 画像をGemini APIに送信して翻訳する関数
  const executeImageAction = async (base64DataUrl: string, currentMode: Mode) => {
    if (!apiKey) {
      setTranslatedText("エラー: APIキーが設定されていません。右上の設定アイコンからGemini APIキーを設定してください。");
      return;
    }

    setLoading(true);
    setTranslatedText("画像を解析して翻訳中...");

    // プレフィックス "data:image/png;base64," を削除して純粋なBase64データを抽出
    const base64Data = base64DataUrl.split(",")[1];

    let prompt = "";
    if (currentMode === "translate") {
      prompt = "この画像の中にある外国語テキストを認識し、文脈を考慮して自然な日本語に翻訳してください。マークダウン形式で翻訳結果のみを出力してください。";
    } else if (currentMode === "summarize") {
      prompt = "この画像の中にあるテキストを日本語で箇条書きで要約してください。";
    } else if (currentMode === "explain") {
      prompt = "この画像の中に写っているコードや専門用語、テキストについて、日本語で詳しく解説してください。";
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: base64Data,
                    },
                  },
                  {
                    text: prompt,
                  },
                ],
              },
            ],
          }),
        }
      );

      if (!response.ok) {
        let details = "";
        try {
          const errJson = await response.json();
          details = errJson.error?.message || response.statusText;
        } catch {
          details = response.statusText;
        }
        throw new Error(`HTTP error! status: ${response.status} (${details})`);
      }

      const data = await response.json();
      const resultText =
        data.candidates?.[0]?.content?.parts?.[0]?.text || "エラー: 画像からテキストを読み取れませんでした。";
      setTranslatedText(resultText);
    } catch (error: any) {
      console.error(error);
      setTranslatedText(`画像翻訳中にエラーが発生しました: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleModeChange = (newMode: Mode) => {
    setMode(newMode);
    if (capturedImage) {
      executeImageAction(capturedImage, newMode);
    } else if (sourceText.trim()) {
      executeAiAction(sourceText, newMode);
    }
  };

  const handleStartCapture = async () => {
    try {
      await invoke("start_capture");
    } catch (err) {
      console.error("Failed to start capture:", err);
    }
  };

  return (
    <div className="app-container">
      {/* ヘッダー */}
      <header className="app-header">
        <div className="logo-section">
          <span className="logo-dot"></span>
          <h1>NexusLingua</h1>
        </div>
        <div className="header-actions">
          {statusMsg && <span className="status-toast">{statusMsg}</span>}
          <button 
            className={`btn-icon ${showSettings ? "active" : ""}`} 
            onClick={() => setShowSettings(!showSettings)}
            title="設定"
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* メインレイアウト */}
      <div className="app-content">
        {/* 設定画面（オーバーレイ） */}
        {showSettings && (
          <div className="settings-panel">
            <h3>Gemini API 設定</h3>
            <p className="settings-desc">
              APIキーを設定し、使用するAIモデルを選択してください。
            </p>
            
            <div className="settings-field">
              <label>使用モデル</label>
              <select 
                value={modelName} 
                onChange={(e) => {
                  const val = e.target.value;
                  setModelName(val);
                  localStorage.setItem("gemini_model_name", val);
                }}
              >
                {availableModels.length > 0 ? (
                  availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))
                ) : (
                  <>
                    <option value="gemini-1.5-flash">gemini-1.5-flash (フォールバック)</option>
                    <option value="gemini-2.0-flash">gemini-2.0-flash (フォールバック)</option>
                    <option value="gemini-1.5-pro">gemini-1.5-pro (フォールバック)</option>
                  </>
                )}
              </select>
            </div>

            <div className="settings-field">
              <label>API キー</label>
              <div className="input-group">
                <input
                  type="password"
                  placeholder="AIzaSy..."
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                <button className="btn-primary" onClick={saveApiKey}>
                  保存
                </button>
              </div>
            </div>
            <p className="api-info">
              キーは <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">Google AI Studio</a> から無料で取得できます。
            </p>
          </div>
        )}

        {/* 翻訳元のテキスト / 画像表示 */}
        <section className="text-section source-box">
          <div className="section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{capturedImage ? "翻訳元 (キャプチャした画像)" : "翻訳元 (選択したテキスト)"}</span>
            <button className="btn-action" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={handleStartCapture}>
              📸 キャプチャ (Alt+S)
            </button>
          </div>
          {capturedImage ? (
            <div className="image-preview-container">
              <img src={capturedImage} alt="Captured" className="captured-preview" />
              <button className="btn-clear-image" onClick={() => setCapturedImage(null)}>
                ✕ 画像をクリアしてテキスト入力に戻る
              </button>
            </div>
          ) : (
            <textarea
              placeholder="テキストを選択して Alt + T を押すか、ここに直接入力してください... (Alt + S で画像翻訳)"
              value={sourceText}
              onChange={(e) => {
                setSourceText(e.target.value);
              }}
            />
          )}
        </section>

        {/* コントロール（タブ） */}
        <div className="controls-row">
          <div className="tabs">
            <button
              className={`tab-btn ${mode === "translate" ? "active" : ""}`}
              onClick={() => handleModeChange("translate")}
            >
              翻訳
            </button>
            <button
              className={`tab-btn ${mode === "summarize" ? "active" : ""}`}
              onClick={() => handleModeChange("summarize")}
            >
              要約
            </button>
            <button
              className={`tab-btn ${mode === "explain" ? "active" : ""}`}
              onClick={() => handleModeChange("explain")}
            >
              解説
            </button>
          </div>
          {(sourceText.trim() || capturedImage) && (
            <button 
              className="btn-action" 
              onClick={() => capturedImage ? executeImageAction(capturedImage, mode) : executeAiAction(sourceText, mode)} 
              disabled={loading}
            >
              {loading ? "実行中..." : "再実行"}
            </button>
          )}
        </div>

        {/* 翻訳結果 */}
        <section className="text-section target-box">
          <div className="section-label">AI 翻訳結果</div>
          <div className="result-container">
            {loading ? (
              <div className="shimmer-wrapper">
                <div className="shimmer-line"></div>
                <div className="shimmer-line shorter"></div>
                <div className="shimmer-line"></div>
              </div>
            ) : (
              <pre className="result-text">{translatedText || "ここに翻訳結果が表示されます。"}</pre>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
