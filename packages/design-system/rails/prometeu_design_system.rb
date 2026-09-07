# frozen_string_literal: true

module Prometeu
  module DesignSystem
    VARIANTS = %w[outline pri ghost danger].freeze
    TONES = %w[success error warning].freeze

    def self.button_class(variant)
      raise ArgumentError, "Unknown button variant: #{variant}" unless VARIANTS.include?(variant.to_s)
      "ui-button #{variant}"
    end

    class FormBuilder < ActionView::Helpers::FormBuilder
      # A validação e o escaping continuam nos helpers nativos do Rails.
      def field(method, label:, type: :text, hint: nil, error: nil, **options)
        helpers = { text: :text_field, email: :email_field, password: :password_field,
          textarea: :text_area, number: :number_field, date: :date_field }
        helper = helpers.fetch(type.to_sym)
        id = options[:id] ||= field_id(method)
        invalid = error.present? || (object.respond_to?(:errors) && object.errors[method].any?)
        description = error.presence || hint
        description_id = "#{id}-description"
        options[:class] = @template.class_names("ui-input", options[:class])
        options[:aria] = (options[:aria] || {}).merge(invalid: invalid ? true : nil,
          describedby: [options.dig(:aria, :describedby), description.present? ? description_id : nil].compact.join(" ").presence)
        control = public_send(helper, method, options)
        if type.to_sym == :password && @options[:password_labels]
          labels = @options.fetch(:password_labels)
          control = @template.tag.div(control, class: "ui-password", data: { ui_password: true,
            ui_show: labels.fetch(:show), ui_hide: labels.fetch(:hide) })
        end
        content = [self.label(method, label, for: id, class: "ui-label"), control]
        if description.present?
          content << @template.tag.span(description, id: description_id,
            class: @template.class_names("ui-hint", "ui-error" => error.present?))
        end
        @template.tag.div(@template.safe_join(content), class: "ui-field")
      end

      def checkbox(method, label:, checked: nil, value: "1", **options)
        options[:checked] = checked unless checked.nil?
        @template.tag.label(@template.safe_join([
          check_box(method, options, value, "0"), @template.tag.span(label)
        ]), class: "ui-check")
      end

      def button(value = nil, options = {})
        options = options.dup
        variant = options.delete(:variant) || :outline
        options[:class] = @template.class_names(DesignSystem.button_class(variant), options[:class])
        super(value, options)
      end
    end

    module Helpers
      def ds_form_with(password_labels: nil, confirm: nil, **options, &block)
        options[:class] = class_names("ui-stack", options.delete(:class) || "ui-card")
        options[:data] = (options[:data] || {}).merge(ui_form: true, ui_confirm: confirm&.to_json)
        form_with(**options, builder: FormBuilder, password_labels: password_labels, &block)
      end

      def ds_button_to(label, url, variant: :outline, confirm: nil, **options)
        form = options.delete(:form) || {}
        form[:data] = (form[:data] || {}).merge(ui_form: true, ui_confirm: confirm&.to_json)
        button_to(label, url, **options, class: class_names(DesignSystem.button_class(variant), options[:class]), form: form)
      end

      def ds_link(label, url, **options)
        link_to(label, url, **options, class: class_names("ui-link", options[:class]))
      end

      def ds_badge(label, success: false)
        tag.span(label, class: class_names("ui-badge", "success" => success))
      end

      def ds_notice(message, tone: :success)
        raise ArgumentError, "Unknown notice tone: #{tone}" unless TONES.include?(tone.to_s)
        tag.p(message, class: "ui-notice #{tone}", role: tone.to_sym == :error ? "alert" : "status")
      end

      def ds_card(title:, description: nil, **options, &block)
        heading = [tag.h2(title)]
        heading << tag.p(description, class: "ui-hint") if description
        tag.section(safe_join([tag.div(safe_join(heading), class: "section-heading"), capture(&block)]),
          **options, class: class_names("ui-card ui-stack", options[:class]))
      end

      def ds_disclosure(title, **options, &block)
        tag.details(safe_join([tag.summary(title), capture(&block)]),
          **options, class: class_names("ui-disclosure", options[:class]))
      end

      # Foto ou logotipo; sem imagem, o glifo de pessoa ou de organização.
      # Decorativo: o nome fica no texto ao lado. Glifos iguais aos de icons.ts.
      GLYPHS = {
        person: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        organization: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>'
      }.freeze

      def ds_avatar(image: nil, kind: :person, size: :sm)
        content = if image
          image_tag(image, alt: "")
        else
          tag.svg(GLYPHS.fetch(kind.to_sym).html_safe, class: "ic", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none",
            stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round")
        end
        tag.span(content, class: class_names("ui-avatar", size, "org" => kind.to_sym == :organization), aria: { hidden: true })
      end

      # Sem JavaScript, o menu continua sendo um disclosure com links nativos.
      # `:sep` separa grupos; `method:` envia um formulário nativo com CSRF.
      # `avatar:` entra no gatilho ao lado do rótulo.
      def ds_menu(label, items:, avatar: nil)
        links = items.map do |item|
          next tag.hr if item == :sep
          if item[:method]
            next button_to(item.fetch(:label), item.fetch(:url), method: item[:method],
              class: class_names("ui-button ghost", "danger" => item[:danger]))
          end
          link_to(item.fetch(:label), item.fetch(:url), class: class_names("ui-link", "danger" => item[:danger]),
            lang: item[:lang], hreflang: item[:lang], aria: { current: item[:current] ? "true" : nil })
        end
        tag.details(safe_join([tag.summary(safe_join([avatar, label].compact), class: "ui-button ghost"), tag.div(safe_join(links))]),
          class: "ui-menu-fallback", data: { ui_menu: true })
      end

      # Abas sublinhadas; a atual recebe aria-current="page".
      def ds_tabs(items, label: nil)
        links = items.map do |item|
          link_to(item.fetch(:label), item.fetch(:url), aria: { current: item[:current] ? "page" : nil })
        end
        tag.nav(safe_join(links), class: "ui-tabs", aria: { label: label })
      end
    end
  end
end
