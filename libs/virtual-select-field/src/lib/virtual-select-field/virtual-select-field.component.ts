import {
  AfterContentInit,
  ChangeDetectorRef,
  Component,
  ContentChild,
  ContentChildren,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Optional,
  Output,
  QueryList,
  Signal,
  TrackByFunction,
  computed,
  inject,
  numberAttribute,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, NgControl } from '@angular/forms';
import {
  MAT_FORM_FIELD,
  MatFormField,
  MatFormFieldControl,
} from '@angular/material/form-field';
import { ActiveDescendantKeyManager, FocusMonitor } from '@angular/cdk/a11y';
import {
  CdkOverlayOrigin,
  OverlayModule,
  ViewportRuler,
} from '@angular/cdk/overlay';
import { BooleanInput, coerceBooleanProperty } from '@angular/cdk/coercion';
import {
  Observable,
  Subject,
  Subscription,
  debounceTime,
  defer,
  merge,
  startWith,
  switchMap,
  take,
  takeUntil,
  tap,
} from 'rxjs';

import { VirtualSelectFieldOptionForDirective } from './virtual-select-field-option-for';

import {
  PANEL_WIDTH_AUTO,
  POSITIONS,
  VIRTUAL_SELECT_CONFIG,
} from './virtual-select-field.constants';
import { VirtualSelectConfig } from './virtual-select-field.models';
import {
  VIRTUAL_SELECT_FIELD_TRIGGER,
  VirtualSelectFieldTriggerDirective,
} from './virtual-select-field-trigger';
import { ScrollingModule } from '@angular/cdk/scrolling';
import {
  VIRTUAL_SELECT_FIELD_OPTION_PARENT,
  VirtualSelectFieldOptionComponent,
  VirtualSelectFieldOptionParent,
  VirtualSelectFieldOptionSelectionChangeEvent,
} from './virtual-select-field-option';
import { SelectionModel } from '@angular/cdk/collections';

@Component({
  selector: 'lib-virtual-select-field',
  standalone: true,
  imports: [CommonModule, OverlayModule, ScrollingModule],
  templateUrl: './virtual-select-field.component.html',
  styleUrl: './virtual-select-field.component.scss',
  providers: [
    { provide: MatFormFieldControl, useExisting: VirtualSelectFieldComponent },
    {
      provide: VIRTUAL_SELECT_FIELD_OPTION_PARENT,
      useExisting: VirtualSelectFieldComponent,
    },
  ],
  host: {
    '(keydown)': 'onKeyDown($event)',
  },
})
// TODO: implement single value typings
export class VirtualSelectFieldComponent<TValue>
  implements
    OnInit,
    OnDestroy,
    AfterContentInit,
    MatFormFieldControl<TValue[]>,
    ControlValueAccessor,
    VirtualSelectFieldOptionParent
{
  // eslint-disable-next-line @angular-eslint/no-input-rename
  @Input('aria-describedby')
  userAriaDescribedBy = '';

  @Input()
  panelWidth: string | number | null =
    this._defaultOptions?.panelWidth ?? PANEL_WIDTH_AUTO;

  @Input({ transform: coerceBooleanProperty })
  multiple: boolean = false;

  @HostBinding('attr.tabindex')
  @Input({
    // eslint-disable-next-line @angular-eslint/no-input-rename
    transform: (value: unknown) => (value == null ? 0 : numberAttribute(value)),
  })
  tabIndex: number = 0;

  @Input({ transform: numberAttribute })
  typeaheadDebounceInterval: number = 100;

  @Output()
  valueChange: EventEmitter<TValue[]> = new EventEmitter<TValue[]>();

  @ContentChild(VirtualSelectFieldOptionForDirective)
  optionFor!: VirtualSelectFieldOptionForDirective<TValue>;

  @ContentChild(VIRTUAL_SELECT_FIELD_TRIGGER)
  customTrigger: VirtualSelectFieldTriggerDirective | null = null;

  @ContentChildren(VirtualSelectFieldOptionComponent)
  optionsQuery: QueryList<VirtualSelectFieldOptionComponent<TValue>> | null =
    null;

  readonly id = `lib-virtual-select-field-${VirtualSelectFieldComponent.nextId++}`;
  readonly controlType = 'lib-virtual-select-field';
  readonly POSITIONS = POSITIONS;
  readonly OVERLAY_PANEL_CLASS: string | string[] =
    this._defaultOptions?.overlayPanelClass || '';

    autofilled = false;
    panelOpen = signal(false);

    overlayWidth: Signal<string | number>;

    ngControl: NgControl | null = inject(NgControl, { optional: true });

    protected readonly _destroy = new Subject<void>();
    protected preferredOverlayOrigin: CdkOverlayOrigin | ElementRef | undefined;

    private _fm: FocusMonitor = inject(FocusMonitor);
    private _elRef: ElementRef<HTMLElement> = inject(ElementRef);
    private _stateChanges = new Subject<void>();

    private _onChange: (value: TValue[]) => void = () => void 0;
    private _onTouched: () => void = () => void 0;

    private _value: TValue[] = [];
    private _focused = false;
    private _required = false;
    private _disabled = false;
    private _touched = false;
    private _placeholder = '';
    private _selectionModel!: SelectionModel<TValue>;
    private _fmMonitorSubscription: Subscription;
    private _viewPortRulerChange: Signal<void>;
    private _scrolledIndexChange = new Subject<void>();
    private _keyManager: ActiveDescendantKeyManager<
    VirtualSelectFieldOptionComponent<TValue>
    > | null = null;

    // NOTE: recursive defer observable to await for options to be rendered
    private readonly _optionSelectionChanges: Observable<
    VirtualSelectFieldOptionSelectionChangeEvent<TValue>
  > = defer(() => {
    const options = this.optionsQuery;

    if (options) {
      return options.changes.pipe(
        startWith(options),
        switchMap(() =>
          merge(...options.map((option) => option.selectedChange))
        )
      );
    }

    return this._ngZone.onStable.pipe(
      take(1),
      switchMap(() => this._optionSelectionChanges)
    );
  }) as Observable<VirtualSelectFieldOptionSelectionChangeEvent<TValue>>;

  // NOTE: optionSelectionChanges in mat select with defer and onStable to await for options to be rendered
  constructor(
    protected _viewportRuler: ViewportRuler,
    protected _changeDetectorRef: ChangeDetectorRef,
    @Optional()
    @Inject(MAT_FORM_FIELD)
    protected _parentFormField: MatFormField,
    readonly _elementRef: ElementRef,
    private _ngZone: NgZone,
    @Optional()
    @Inject(VIRTUAL_SELECT_CONFIG)
    protected _defaultOptions?: VirtualSelectConfig
  ) {
    if (this.ngControl != null) {
      this.ngControl.valueAccessor = this;
    }

    this._fmMonitorSubscription = this._fm
      .monitor(this._elRef, true)
      .subscribe((origin) => {
        this._focused = !!origin;
        this._stateChanges.next();
      });

    // NOTE: View port ruler change stream runs outside the zone.
    //       Need to run change detection manually to trigger computed signal below.
    this._viewPortRulerChange = toSignal(
      this._viewportRuler
        .change()
        .pipe(tap(() => this._changeDetectorRef.detectChanges()))
    );

    this.overlayWidth = computed(() => {
      this._viewPortRulerChange();

      if (!this.panelOpen()) {
        return 0;
      }

      return this.resolveOverlayWidth(this.preferredOverlayOrigin);
    });
  }

  @Input()
  set value(value: TValue[]) {
    if (this.value === value) {
      return;
    }

    this._value = value ? value : [];
    this._selectionModel?.select(...this._value);

    this._stateChanges.next();
  }

  get value() {
    return this._value;
  }

  @Input()
  get placeholder(): string {
    return this._placeholder;
  }

  set placeholder(placeholder: string) {
    this._placeholder = placeholder;
    this._stateChanges.next();
  }

  @Input()
  get required(): boolean {
    return this._required;
  }

  set required(req: boolean) {
    this._required = coerceBooleanProperty(req);
    this._stateChanges.next();
  }

  @Input()
  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(value: BooleanInput) {
    this._disabled = coerceBooleanProperty(value);
    this._stateChanges.next();
  }

  get shouldLabelFloat() {
    return this.focused || !this.empty;
  }

  get empty() {
    return this._value?.length === 0;
  }

  get stateChanges(): Observable<void> {
    return this._stateChanges.asObservable();
  }

  get errorState(): boolean {
    return !!this.ngControl?.invalid && this._touched;
  }

  // NOTE: material components use class mat-form-field-hide-placeholder
  @HostBinding('class.lib-virtual-select-hide-placeholder')
  get hidePlaceholder() {
    return !this.focused || !this.empty;
  }

  get triggerValue(): string {
    if (this.empty) {
      return '';
    }

    //TODO: resolve trigger text bu selected values

    return 'mock build in trigger';
  }

  get focused(): boolean {
    // NOTE: panel open is needed to keep form field in focused state during interaction with options
    return this._focused || this.panelOpen();
  }

  ngOnInit() {
    // TODO: mb move to constructor
    // TODO: mb use disabled property instead of false
    this._disabled = this.ngControl?.disabled ?? false;

    // TODO: consider using this._selectionModel.changed
    this._selectionModel = new SelectionModel<TValue>(this.multiple);
    this._selectionModel?.select(...this._value);
  }

  ngAfterContentInit() {
    // TODO: mb create new keyManger on optionFor.options$ change
    this.initKeyManager();

    // TODO: mb merge both subscriptions
    this.optionFor.options$
      .pipe(
        takeUntil(this._destroy),
        switchMap(() => this._optionSelectionChanges)
      )
      .subscribe(
        (
          selectionEvent: VirtualSelectFieldOptionSelectionChangeEvent<TValue>
        ) => this.updateOptionSelection(selectionEvent)
      );

    this.optionFor.options$
      .pipe(
        takeUntil(this._destroy),
        switchMap(() => this._scrolledIndexChange),
        debounceTime(100)
      )
      .subscribe(() => this.updateRenderedOptionsState());
  }

  private updateOptionSelection(
    selectionEvent: VirtualSelectFieldOptionSelectionChangeEvent<TValue>
  ) {
    if (this.multiple) {
      this._selectionModel.toggle(selectionEvent.value);
    } else {
      this._selectionModel.select(selectionEvent.value);
      this.optionsQuery?.forEach((option) => {
        if (option.value !== selectionEvent.value) {
          option.deselect();
        }
      });

      this.close();
    }

    this._keyManager?.setActiveItem(selectionEvent.source);
    // TODO: this need to keep form field in focus state
    this.focus();
  }

  private updateRenderedOptionsState() {
    this.optionsQuery!.forEach((option) => {
      // NOTE: deselect for all is needed because of virtual scroll and reusing options
      option.deselect();
      if (this._selectionModel.isSelected(option.value)) {
        option.select();
      }
    });
  }

  ngOnDestroy() {
    this._stateChanges.complete();
    this._fm.stopMonitoring(this._elRef);
    this._fmMonitorSubscription?.unsubscribe();
  }

  // #region ControlValueAccessor

  writeValue(value: TValue[]): void {
    this.value = value;
  }

  registerOnChange(fn: (value: TValue[]) => void) {
    this._onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this._onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  // #endregion ControlValueAccessor

  setDescribedByIds(ids: string[]) {
    const controlElement = this._elRef.nativeElement;

    controlElement.setAttribute('aria-describedby', ids.join(' '));
  }

  onContainerClick(): void {
    this.focus();
    this.open();
  }

  onOverlayAttached() {
    // TODO: navigate to active option
  }

  @HostListener('focus')
  protected onFocusIn() {
    if (!this.focused) {
      this._focused = true;
      this._stateChanges.next();
    }
  }

  @HostListener('blur')
  protected onFocusOut() {
    this._focused = false;

    if (!this.panelOpen()) {
      this._touched = true;
      this._onTouched();
      this._stateChanges.next();
    }
  }

  // @HostListener('keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent) {
    if (this.panelOpen()) {
      this._keyManager?.onKeydown(event);
    } else {
      //
    }
  }

  protected trackByOptions: TrackByFunction<{ label: string; value: TValue }> =
    (index: number, options: { label: string; value: TValue }) => {
      return options.value;
    };

  protected onScrolledIndexChange(): void {
    this._scrolledIndexChange.next();
  }

  protected emitValue(): void {
    this._onChange?.(this.value);
    this.valueChange.emit(this.value);
  }

  protected toggle(): void {
    if (this.panelOpen()) {
      this.close();
    } else {
      this.open;
    }
  }

  protected open() {
    if (this._parentFormField) {
      this.preferredOverlayOrigin =
        this._parentFormField.getConnectedOverlayOrigin();
    }

    this.panelOpen.set(true);
  }

  protected close() {
    this.panelOpen.set(false);
  }

  private focus() {
    this._elementRef.nativeElement.focus();
  }

  private resolveOverlayWidth(
    preferredOrigin: ElementRef<ElementRef> | CdkOverlayOrigin | undefined
  ): string | number {
    if (this.panelWidth === PANEL_WIDTH_AUTO) {
      const refToMeasure =
        preferredOrigin instanceof CdkOverlayOrigin
          ? preferredOrigin.elementRef
          : preferredOrigin || this._elementRef;
      return refToMeasure.nativeElement.getBoundingClientRect().width;
    }

    return this.panelWidth === null ? '' : this.panelWidth;
  }

  private initKeyManager() {
    // TODO: use parent ListKeyManager
    // pass array from optionsFor directive
    // handle active item change
    // implmenet ListKeyManagerOption for option item interface in optionsFor
    this._keyManager = new ActiveDescendantKeyManager<
      VirtualSelectFieldOptionComponent<TValue>
    >(this.optionsQuery!)
      .withTypeAhead(this.typeaheadDebounceInterval)
      .withVerticalOrientation()
      // .withHorizontalOrientation(this._isRtl() ? 'rtl' : 'ltr')
      .withHomeAndEnd()
      .withPageUpDown()
      .withAllowedModifierKeys(['shiftKey']);
    // .skipPredicate(this._skipPredicate)

    this._keyManager.tabOut.subscribe(() => {
      if (this.panelOpen()) {
        // Select the active item when tabbing away. This is consistent with how the native
        // select behaves. Note that we only want to do this in single selection mode.
        // if (!this.multiple && this._keyManager.activeItem) {
        //   this._keyManager.activeItem._selectViaInteraction();
        // }

        // Restore focus to the trigger before closing. Ensures that the focus
        // position won't be lost if the user got focus into the overlay.
        this.focus();
        this.close();
      }
    });
  }

  static ngAcceptInputType_required: BooleanInput;
  static ngAcceptInputType_disabled: BooleanInput;

  static nextId = 0;
}
