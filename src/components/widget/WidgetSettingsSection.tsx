"use client";

/**
 * Widget screen "Widget settings" panel (WIDG-04): Position (segmented control) and Title (text
 * input, 40-char live counter). The segmented control's active state is one of the UI-SPEC Color
 * section's three permitted accent placements on this screen.
 */

const TITLE_MAX_LENGTH = 40;

interface WidgetSettingsSectionProps {
  position: "bottom-right" | "bottom-left";
  title: string;
  onChange: (patch: Partial<{ position: "bottom-right" | "bottom-left"; title: string }>) => void;
}

export default function WidgetSettingsSection({ position, title, onChange }: WidgetSettingsSectionProps) {
  return (
    <section className="panel widget-form-panel" data-testid="widget-settings-section">
      <div className="panel__header">
        <div className="panel__title">Widget settings</div>
      </div>
      <div className="panel__body widget-form-panel__body">
        <div className="widget-form-field">
          <span className="widget-form-field__label">Position</span>
          <div className="widget-position-toggle" role="group" aria-label="Widget position">
            <button
              type="button"
              className={`widget-position-toggle__option${position === "bottom-right" ? " is-active" : ""}`}
              aria-pressed={position === "bottom-right"}
              onClick={() => onChange({ position: "bottom-right" })}
            >
              Bottom right
            </button>
            <button
              type="button"
              className={`widget-position-toggle__option${position === "bottom-left" ? " is-active" : ""}`}
              aria-pressed={position === "bottom-left"}
              onClick={() => onChange({ position: "bottom-left" })}
            >
              Bottom left
            </button>
          </div>
        </div>

        <label className="widget-form-field">
          <span className="widget-form-field__label">
            Title
            <span className="widget-form-field__counter" data-testid="title-counter">
              {title.length}/{TITLE_MAX_LENGTH}
            </span>
          </span>
          <input
            type="text"
            value={title}
            maxLength={TITLE_MAX_LENGTH}
            onChange={(e) => onChange({ title: e.target.value })}
            aria-label="Widget panel title"
          />
        </label>
      </div>
    </section>
  );
}
